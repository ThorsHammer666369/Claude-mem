
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { getCredential } from '../../shared/EnvManager.js';
import { USER_SETTINGS_PATH, paths } from '../../shared/paths.js';
import { estimateTokens } from '../../shared/timeline-formatting.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ModeConfig } from '../domain/types.js';
import {
  processAgentResponse,
  isAbortError,
  type WorkerRef
} from './agents/index.js';
import { ClassifiedProviderError, isContextOverflowMessage, isProviderContextOverflowError } from './provider-errors.js';
import { withRetry } from './retry.js';
import { SmartLlmDrain, type DrainItem, type SmartLlmDrainOptions } from './llm/SmartLlmDrain.js';
import { parseSmartLlmDrainOptions } from './llm/SmartLlmDrainSettings.js';
import { SmartLlmContextSplitter } from './llm/SmartLlmContextSplitter.js';
import { buildContextOverflowRetryPlan } from './llm/SmartLlmContextOverflowRetry.js';
import {
  buildObservationPromptFromDrainItem,
  getDrainItemAgentMetadata,
  getDrainItemCwd,
  getDrainItemPromptNumber,
} from './llm/SmartLlmDrainPromptBuilder.js';
import { recordSmartLlmDrainMetrics } from './llm/SmartLlmDrainMetricsRegistry.js';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1/models';

interface ObservationSplitProgress {
  storedParts: number;
}

/**
 * Parse Retry-After header (seconds or HTTP-date).
 * Returns ms or undefined.
 */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

/**
 * Classify a Gemini fetch failure into ClassifiedProviderError. Called at
 * the boundary right after `fetch()` returns or throws. Provider-specific
 * because Gemini surfaces auth/quota/rate-limit signals via specific status
 * codes and body strings (e.g. "quota exceeded", "API key not valid").
 */
export function classifyGeminiError(input: {
  status?: number;
  bodyText?: string;
  headers?: Headers | { get(name: string): string | null };
  cause: unknown;
  requestId?: string;
}): ClassifiedProviderError {
  const status = input.status;
  const body = input.bodyText ?? '';
  const lower = body.toLowerCase();
  const headers = input.headers;
  const retryAfterMs = headers ? parseRetryAfterMs(headers.get('retry-after')) : undefined;

  // Quota exceeded — by body marker — even on 500 (Gemini quirk).
  if (lower.includes('quota exceeded') || lower.includes('resource_exhausted')) {
    return new ClassifiedProviderError(
      `Gemini quota exhausted${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'quota_exhausted', cause: input.cause },
    );
  }

  if (isContextOverflowMessage(body)) {
    return new ClassifiedProviderError(
      `Gemini context overflow${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'context_overflow', cause: input.cause },
    );
  }

  if (status === 429) {
    return new ClassifiedProviderError(
      'Gemini rate limit (429)',
      { kind: 'rate_limit', cause: input.cause, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  if (status === 401 || status === 403) {
    // API_KEY_INVALID, PERMISSION_DENIED, etc.
    if (lower.includes('api key not valid') || lower.includes('api_key_invalid') || lower.includes('api key expired')) {
      return new ClassifiedProviderError(
        `Gemini auth invalid (status ${status})`,
        { kind: 'auth_invalid', cause: input.cause },
      );
    }
    return new ClassifiedProviderError(
      `Gemini auth error (status ${status})`,
      { kind: 'auth_invalid', cause: input.cause },
    );
  }

  if (status === 400) {
    return new ClassifiedProviderError(
      `Gemini bad request (status 400)`,
      { kind: 'unrecoverable', cause: input.cause },
    );
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ClassifiedProviderError(
      `Gemini upstream error (status ${status})`,
      { kind: 'transient', cause: input.cause },
    );
  }

  // Network errors (no status) — treat as transient.
  if (status === undefined) {
    return new ClassifiedProviderError(
      `Gemini network error: ${input.cause instanceof Error ? input.cause.message : String(input.cause)}`,
      { kind: 'transient', cause: input.cause },
    );
  }

  return new ClassifiedProviderError(
    `Gemini API error: ${status}${body ? ` - ${body.substring(0, 200)}` : ''}`,
    { kind: 'unrecoverable', cause: input.cause },
  );
}

export type GeminiModel =
  | 'gemini-2.5-flash-lite'
  | 'gemini-2.5-flash'
  | 'gemini-2.5-pro'
  | 'gemini-2.0-flash'
  | 'gemini-2.0-flash-lite'
  | 'gemini-3-flash'
  | 'gemini-3-flash-preview';

const GEMINI_RPM_LIMITS: Record<GeminiModel, number> = {
  'gemini-2.5-flash-lite': 10,
  'gemini-2.5-flash': 10,
  'gemini-2.5-pro': 5,
  'gemini-2.0-flash': 15,
  'gemini-2.0-flash-lite': 30,
  'gemini-3-flash': 10,
  'gemini-3-flash-preview': 5,
};

let lastRequestTime = 0;

const DEFAULT_MAX_CONTEXT_MESSAGES = 20;  
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;  

async function enforceRateLimitForModel(model: GeminiModel, rateLimitingEnabled: boolean): Promise<void> {
  if (!rateLimitingEnabled) {
    return;
  }

  const rpm = GEMINI_RPM_LIMITS[model] || 5;
  const minimumDelayMs = Math.ceil(60000 / rpm) + 100; 

  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < minimumDelayMs) {
    const waitTime = minimumDelayMs - timeSinceLastRequest;
    logger.debug('SDK', `Rate limiting: waiting ${waitTime}ms before Gemini request`, { model, rpm });
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  lastRequestTime = Date.now();
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

export class GeminiProvider {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const { apiKey, model, rateLimitingEnabled } = this.getGeminiConfig();

    if (!apiKey) {
      throw new Error('Gemini API key not configured. Set CLAUDE_MEM_GEMINI_API_KEY in settings or GEMINI_API_KEY environment variable.');
    }

    if (!session.memorySessionId) {
      const syntheticMemorySessionId = `gemini-${session.contentSessionId}-${Date.now()}`;
      session.memorySessionId = syntheticMemorySessionId;
      this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
      logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=Gemini`);
    }

    const mode = ModeManager.getInstance().getActiveMode();
    const initPrompt = session.lastPromptNumber === 1
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

    session.conversationHistory.push({ role: 'user', content: initPrompt });
    let initResponse: { content: string; tokensUsed?: number };
    try {
      initResponse = await this.queryGeminiMultiTurn(session.conversationHistory, apiKey, model, rateLimitingEnabled);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', 'Gemini init query failed', { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', 'Gemini init query failed with non-Error', { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      return this.handleGeminiError(error, session, worker);
    }

    if (initResponse.content) {
      const tokensUsed = initResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);  
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
      await processAgentResponse(initResponse.content, session, this.dbManager, this.sessionManager, worker, tokensUsed, null, 'Gemini', undefined, model);
    } else {
      logger.error('SDK', 'Empty Gemini init response - session may lack context', { sessionId: session.sessionDbId, model });
    }

    try {
      await this.processMessageLoop(session, worker, apiKey, model, rateLimitingEnabled, mode);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', 'Gemini message loop failed', { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', 'Gemini message loop failed with non-Error', { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      return this.handleGeminiError(error, session, worker);
    }

    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', 'Gemini agent completed', {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      historyLength: session.conversationHistory.length
    });
  }

  private async processMessageLoop(
    session: ActiveSession,
    worker: WorkerRef | undefined,
    apiKey: string,
    model: GeminiModel,
    rateLimitingEnabled: boolean,
    mode: ModeConfig
  ): Promise<void> {
    let lastCwd: string | undefined;
    const drainOptions = parseSmartLlmDrainOptions(SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH));
    const drain = new SmartLlmDrain(drainOptions, {
      getQueueDepth: () => this.sessionManager.getTotalQueueDepth(),
      onMetrics: metrics => recordSmartLlmDrainMetrics('Gemini', metrics),
    });
    const splitter = new SmartLlmContextSplitter(drainOptions.contextSplit);

    for await (const item of drain.drain(
      this.sessionManager.getMessageIterator(session.sessionDbId),
      session.abortController.signal
    )) {
      const metadata = getDrainItemAgentMetadata(item);
      session.pendingAgentId = metadata.agentId;
      session.pendingAgentType = metadata.agentType;

      const itemCwd = getDrainItemCwd(item);
      if (itemCwd) {
        lastCwd = itemCwd;
      }
      const originalTimestamp = session.earliestPendingTimestamp;

      if (item.kind === 'single' && item.message.type === 'summarize') {
        await this.processSummaryMessage(session, item.message, worker, apiKey, model, rateLimitingEnabled, mode, originalTimestamp, lastCwd, drain);
      } else {
        const parts = splitter.split(item);
        this.logSplitParts(session.sessionDbId, item, parts);
        const progress: ObservationSplitProgress = { storedParts: 0 };
        try {
          lastCwd = await this.processObservationParts(
            session, parts, worker, apiKey, model, rateLimitingEnabled, originalTimestamp, lastCwd, drain, progress
          );
        } catch (error) {
          if (this.shouldHardStopPartialSplitContextOverflow(error, session, item, progress, model)) {
            throw error;
          }
          const retryPlan = buildContextOverflowRetryPlan(error, item, parts, drainOptions.contextSplit);
          if (!retryPlan) {
            if (await this.retryOrFailContextOverflowItem(error, session, item, drainOptions)) {
              continue;
            }
            throw error;
          }
          logger.warn('QUEUE', 'Context overflow retry with smaller split budget', {
            sessionDbId: session.sessionDbId,
            provider: 'Gemini',
            model,
            sourceIds: item.sourceIds,
            previousMaxChars: drainOptions.contextSplit.maxChars,
            retryMaxChars: retryPlan.options.maxChars,
            retryMaxParts: retryPlan.options.maxParts,
            retrySplitTotal: retryPlan.parts.length,
          });
          const retryProgress: ObservationSplitProgress = { storedParts: 0 };
          try {
            lastCwd = await this.processObservationParts(
              session, retryPlan.parts, worker, apiKey, model, rateLimitingEnabled, originalTimestamp, lastCwd, drain, retryProgress
            );
          } catch (retryError) {
            if (this.shouldHardStopPartialSplitContextOverflow(retryError, session, item, retryProgress, model)) {
              throw retryError;
            }
            if (await this.retryOrFailContextOverflowItem(retryError, session, item, drainOptions)) {
              continue;
            }
            throw retryError;
          }
        }
      }
    }
  }

  private async retryOrFailContextOverflowItem(
    error: unknown,
    session: ActiveSession,
    item: DrainItem,
    drainOptions: SmartLlmDrainOptions
  ): Promise<boolean> {
    if (!isProviderContextOverflowError(error)) {
      return false;
    }

    const retryDelayMs = Math.max(250, drainOptions.minSendIntervalMs);
    const result = await this.sessionManager.retryOrFailClaimedMessageIds(
      session.sessionDbId,
      item.sourceIds,
      'context_overflow',
      drainOptions.maxAttempts,
      Date.now() + retryDelayMs
    );
    session.activeSplitPart = null;
    session.splitGroupProgress = null;
    logger.warn('QUEUE', 'Message retry/dead-letter decision after provider context overflow', {
      sessionDbId: session.sessionDbId,
      provider: 'Gemini',
      sourceIds: item.sourceIds,
      retried: result.retried,
      failed: result.failed,
      maxAttempts: drainOptions.maxAttempts,
    });
    return true;
  }

  private shouldHardStopPartialSplitContextOverflow(
    error: unknown,
    session: ActiveSession,
    item: DrainItem,
    progress: ObservationSplitProgress,
    model: string
  ): boolean {
    if (progress.storedParts <= 0 || !isProviderContextOverflowError(error)) {
      return false;
    }

    session.activeSplitPart = null;
    session.splitGroupProgress = null;
    logger.error('QUEUE', 'Context overflow after partial split storage; hard-stopping session to avoid duplicate retry', {
      sessionDbId: session.sessionDbId,
      provider: 'Gemini',
      model,
      sourceIds: item.sourceIds,
      storedSplitParts: progress.storedParts,
      reason: 'partial_split_context_overflow',
    });
    return true;
  }

  private logSplitParts(sessionDbId: number, item: DrainItem, parts: DrainItem[]): void {
    if (parts.length > 1) {
      logger.info('QUEUE', 'Split observation drain item for provider sends', {
        sessionDbId,
        splitGroupId: parts[0].splitMetadata?.splitGroupId,
        splitTotal: parts.length,
        originalSourceIds: item.sourceIds,
      });
    }
  }

  private async processObservationParts(
    session: ActiveSession,
    parts: DrainItem[],
    worker: WorkerRef | undefined,
    apiKey: string,
    model: GeminiModel,
    rateLimitingEnabled: boolean,
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    drain: SmartLlmDrain,
    progress: ObservationSplitProgress = { storedParts: 0 }
  ): Promise<string | undefined> {
    let totalLatencyMs = 0;
    let recordedFailure = false;
    for (const part of parts) {
      const partMetadata = getDrainItemAgentMetadata(part);
      session.pendingAgentId = partMetadata.agentId;
      session.pendingAgentType = partMetadata.agentType;
      const partCwd = getDrainItemCwd(part);
      if (partCwd) {
        lastCwd = partCwd;
      }

      const result = await this.processObservationDrainItem(
        session,
        part,
        worker,
        apiKey,
        model,
        rateLimitingEnabled,
        originalTimestamp,
        lastCwd,
        drain,
        parts.length === 1
      );
      totalLatencyMs += result.latencyMs;
      if (result.kind === 'stored') {
        progress.storedParts++;
      }
      if (parts.length > 1 && result.kind === 'invalid') {
        if (result.empty) {
          drain.recordProviderEmptyResponse('empty_split_observation_response');
        } else {
          drain.recordParserFailure('invalid_split_observation_response');
        }
        recordedFailure = true;
        break;
      }
    }

    if (parts.length > 1 && !recordedFailure) {
      drain.recordProviderSuccess(totalLatencyMs);
    }
    return lastCwd;
  }

  private async processObservationDrainItem(
    session: ActiveSession,
    item: DrainItem,
    worker: WorkerRef | undefined,
    apiKey: string,
    model: GeminiModel,
    rateLimitingEnabled: boolean,
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    drain: SmartLlmDrain,
    recordDrainMetrics = true
  ): Promise<{ kind: 'stored' | 'invalid' | 'deferred'; empty: boolean; latencyMs: number }> {
    const promptNumber = getDrainItemPromptNumber(item);
    if (promptNumber !== undefined) {
      session.lastPromptNumber = promptNumber;
    }

    if (!session.memorySessionId) {
      throw new Error('Cannot process observations: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    if (item.kind !== 'single') {
      logger.info('QUEUE', item.kind === 'coalesced' ? 'Coalesced observations' : 'Batched observations', {
        sessionDbId: session.sessionDbId,
        sourceIds: item.sourceIds,
        count: item.sourceIds.length,
      });
    }

    const obsPrompt = buildObservationPromptFromDrainItem(item, originalTimestamp ?? Date.now());

    session.conversationHistory.push({ role: 'user', content: obsPrompt });
    const queryStartedAt = Date.now();
    let obsResponse: { content: string; tokensUsed?: number };
    try {
      obsResponse = await this.queryGeminiMultiTurn(session.conversationHistory, apiKey, model, rateLimitingEnabled);
    } catch (error) {
      const lastMessage = session.conversationHistory[session.conversationHistory.length - 1];
      if (lastMessage?.role === 'user' && lastMessage.content === obsPrompt) {
        session.conversationHistory.pop();
      }
      throw error;
    }
    const latencyMs = Date.now() - queryStartedAt;

    let tokensUsed = 0;
    if (obsResponse.content) {
      tokensUsed = obsResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
    }

    const outcome = await processAgentResponse(
      obsResponse.content || '',
      session,
      this.dbManager,
      this.sessionManager,
      worker,
      tokensUsed,
      originalTimestamp,
      'Gemini',
      lastCwd,
      model,
      item.splitMetadata ? { splitPart: item.splitMetadata } : undefined
    );
    if (recordDrainMetrics) {
      if (!obsResponse.content) {
        drain.recordProviderEmptyResponse('empty_observation_response');
      } else if (outcome.kind === 'invalid') {
        drain.recordParserFailure('invalid_observation_response');
      } else {
        drain.recordProviderSuccess(latencyMs);
      }
    }
    return { kind: outcome.kind, empty: !obsResponse.content, latencyMs };
  }

  private async processSummaryMessage(
    session: ActiveSession,
    message: { type: string; last_assistant_message?: string },
    worker: WorkerRef | undefined,
    apiKey: string,
    model: GeminiModel,
    rateLimitingEnabled: boolean,
    mode: ModeConfig,
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    drain: SmartLlmDrain
  ): Promise<void> {
    if (!session.memorySessionId) {
      throw new Error('Cannot process summary: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const summaryPrompt = buildSummaryPrompt({
      id: session.sessionDbId,
      memory_session_id: session.memorySessionId,
      project: session.project,
      user_prompt: session.userPrompt,
      last_assistant_message: message.last_assistant_message || ''
    }, mode);

    session.conversationHistory.push({ role: 'user', content: summaryPrompt });
    const queryStartedAt = Date.now();
    let summaryResponse: { content: string; tokensUsed?: number };
    try {
      summaryResponse = await this.queryGeminiMultiTurn(session.conversationHistory, apiKey, model, rateLimitingEnabled);
    } catch (error) {
      const lastMessage = session.conversationHistory[session.conversationHistory.length - 1];
      if (lastMessage?.role === 'user' && lastMessage.content === summaryPrompt) {
        session.conversationHistory.pop();
      }
      throw error;
    }
    const latencyMs = Date.now() - queryStartedAt;

    let tokensUsed = 0;
    if (summaryResponse.content) {
      tokensUsed = summaryResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
    }

    const outcome = await processAgentResponse(summaryResponse.content || '', session, this.dbManager, this.sessionManager, worker, tokensUsed, originalTimestamp, 'Gemini', lastCwd, model);
    if (!summaryResponse.content) {
      drain.recordProviderEmptyResponse('empty_summary_response');
    } else if (outcome.kind === 'invalid') {
      drain.recordParserFailure('invalid_summary_response');
    } else {
      drain.recordProviderSuccess(latencyMs);
    }
  }

  private handleGeminiError(error: unknown, session: ActiveSession, _worker?: WorkerRef): never {
    if (isAbortError(error)) {
      logger.warn('SDK', 'Gemini agent aborted', { sessionId: session.sessionDbId });
      throw error;
    }

    logger.failure('SDK', 'Gemini agent error', { sessionDbId: session.sessionDbId }, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const MAX_CONTEXT_MESSAGES = parseInt(settings.CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const MAX_ESTIMATED_TOKENS = parseInt(settings.CLAUDE_MEM_GEMINI_MAX_TOKENS) || DEFAULT_MAX_ESTIMATED_TOKENS;

    if (history.length <= MAX_CONTEXT_MESSAGES) {
      const totalTokens = history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
      if (totalTokens <= MAX_ESTIMATED_TOKENS) {
        return history;
      }
    }

    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = estimateTokens(msg.content);

      if (truncated.length > 0 && (truncated.length >= MAX_CONTEXT_MESSAGES || tokenCount + msgTokens > MAX_ESTIMATED_TOKENS)) {
        logger.warn('SDK', 'Context window truncated to prevent runaway costs', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: MAX_ESTIMATED_TOKENS
        });
        break;
      }

      truncated.unshift(msg);  
      tokenCount += msgTokens;
    }

    return truncated;
  }

  private conversationToGeminiContents(history: ConversationMessage[]): GeminiContent[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));
  }

  private async queryGeminiMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: GeminiModel,
    rateLimitingEnabled: boolean
  ): Promise<{ content: string; tokensUsed?: number }> {
    const truncatedHistory = this.truncateHistory(history);
    const contents = this.conversationToGeminiContents(truncatedHistory);
    const totalChars = truncatedHistory.reduce((sum, m) => sum + m.content.length, 0);

    logger.debug('SDK', `Querying Gemini multi-turn (${model})`, {
      turns: truncatedHistory.length,
      totalTurns: history.length,
      totalChars
    });

    const url = `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`;

    await enforceRateLimitForModel(model, rateLimitingEnabled);

    // Track request-id (best-effort dedup) across retries.
    let priorRequestId: string | null = null;

    const data = await withRetry<GeminiResponse>(async (attemptSignal) => {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(priorRequestId ? { 'x-claude-mem-prior-request-id': priorRequestId } : {}),
          },
          body: JSON.stringify({
            contents,
            generationConfig: {
              temperature: 0.3,  // Lower temperature for structured extraction
              maxOutputTokens: 4096,
            },
          }),
          signal: attemptSignal,
        });
      } catch (networkError: unknown) {
        // Network failures, aborts, DNS, etc.
        throw classifyGeminiError({
          cause: networkError,
        });
      }

      const requestId = response.headers.get('x-goog-request-id') ?? response.headers.get('x-request-id');
      if (requestId) {
        priorRequestId = requestId;
      } else {
        logger.debug('SDK', 'Gemini response missing request-id header; retry dedup is best-effort');
      }

      if (!response.ok) {
        const errorBody = await response.text();
        throw classifyGeminiError({
          status: response.status,
          bodyText: errorBody,
          headers: response.headers,
          cause: new Error(`Gemini API error: ${response.status} - ${errorBody}`),
          ...(requestId ? { requestId } : {}),
        });
      }

      return await response.json() as GeminiResponse;
    }, { label: `Gemini ${model}` });

    if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
      logger.error('SDK', 'Empty response from Gemini');
      return { content: '' };
    }

    const content = data.candidates[0].content.parts[0].text;
    const tokensUsed = data.usageMetadata?.totalTokenCount;

    return { content, tokensUsed };
  }

  private getGeminiConfig(): { apiKey: string; model: GeminiModel; rateLimitingEnabled: boolean } {
    const settingsPath = paths.settings();
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    const apiKey = settings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY') || '';

    const defaultModel: GeminiModel = 'gemini-2.5-flash';
    const configuredModel = settings.CLAUDE_MEM_GEMINI_MODEL || defaultModel;
    const validModels: GeminiModel[] = [
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-3-flash',
      'gemini-3-flash-preview',
    ];

    let model: GeminiModel;
    if (validModels.includes(configuredModel as GeminiModel)) {
      model = configuredModel as GeminiModel;
    } else {
      logger.warn('SDK', `Invalid Gemini model "${configuredModel}", falling back to ${defaultModel}`, {
        configured: configuredModel,
        validModels,
      });
      model = defaultModel;
    }

    const rateLimitingEnabled = settings.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED !== 'false';

    return { apiKey, model, rateLimitingEnabled };
  }
}

export function isGeminiAvailable(): boolean {
  const settingsPath = paths.settings();
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!(settings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY'));
}

export function isGeminiSelected(): boolean {
  const settingsPath = paths.settings();
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'gemini';
}
