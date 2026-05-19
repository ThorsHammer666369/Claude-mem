
import { logger } from '../../../utils/logger.js';
import { parseAgentXml, type ParsedObservation, type ParsedSummary } from '../../../sdk/parser.js';
import { ingestSummary } from '../http/shared.js';
import { updateCursorContextForProject } from '../../integrations/CursorHooksInstaller.js';
import { notifyTelegram } from '../../integrations/TelegramNotifier.js';
import { updateFolderClaudeMdFiles } from '../../../utils/claude-md-utils.js';
import { getWorkerPort } from '../../../shared/worker-utils.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import type { ActiveSession } from '../../worker-types.js';
import type { DatabaseManager } from '../DatabaseManager.js';
import type { SessionManager } from '../SessionManager.js';
import type { WorkerRef, StorageResult } from './types.js';
import { broadcastObservation, broadcastSummary } from './ObservationBroadcaster.js';
import { parseSmartLlmDrainOptions } from '../llm/SmartLlmDrainSettings.js';
import type { SplitDrainMetadata } from '../llm/SmartLlmDrain.js';
import { ClassifiedProviderError } from '../provider-errors.js';

export type AgentResponseOutcome =
  | { kind: 'stored'; observationCount: number; summaryStored: boolean }
  | { kind: 'invalid'; empty: boolean; retried: number; failed: number }
  | { kind: 'deferred'; reason: 'missing_memory_session_id' };

export interface AgentResponseProcessingOptions {
  splitPart?: SplitDrainMetadata;
}

export async function processAgentResponse(
  text: string,
  session: ActiveSession,
  dbManager: DatabaseManager,
  sessionManager: SessionManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  originalTimestamp: number | null,
  agentName: string,
  projectRoot?: string,
  modelId?: string,
  options: AgentResponseProcessingOptions = {}
): Promise<AgentResponseOutcome> {
  session.lastGeneratorActivity = Date.now();
  const splitPart = options.splitPart;

  const parsed = parseAgentXml(text, session.contentSessionId);

  if (!parsed.valid) {
    logger.warn('PARSER', `${agentName} returned non-XML/empty response — ignoring queued batch`, {
      sessionId: session.sessionDbId,
      ...(splitPart ? splitLogContext(splitPart) : {}),
    });
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const drainOptions = parseSmartLlmDrainOptions(settings);
    const retryDelayMs = Math.max(250, drainOptions.minSendIntervalMs);
    if (splitPart && hasStoredPreviousSplitPart(session, splitPart)) {
      session.activeSplitPart = null;
      session.splitGroupProgress = null;
      logger.error('QUEUE', 'Invalid split response after partial split storage; hard-stopping session to avoid duplicate retry', {
        sessionDbId: session.sessionDbId,
        reason: 'partial_split_invalid_response',
        parserReason: parsed.reason,
        ...splitLogContext(splitPart),
      });
      worker?.broadcastProcessingStatus?.();
      throw new ClassifiedProviderError(
        'Invalid partial split response after earlier split parts stored',
        {
          kind: 'unrecoverable',
          cause: new Error(parsed.reason || 'invalid split response'),
        }
      );
    }
    const retryResult = splitPart
      ? await sessionManager.retryOrFailClaimedMessageIds(
        session.sessionDbId,
        splitPart.originalSourceIds,
        'invalid_or_empty_response',
        drainOptions.maxAttempts,
        Date.now() + retryDelayMs
      )
      : await sessionManager.retryOrFailClaimedMessages(
        session.sessionDbId,
        'invalid_or_empty_response',
        drainOptions.maxAttempts,
        Date.now() + retryDelayMs
      );
    logger.warn('QUEUE', 'Message retry/dead-letter decision after invalid provider response', {
      sessionDbId: session.sessionDbId,
      retried: retryResult.retried,
      failed: retryResult.failed,
      maxAttempts: drainOptions.maxAttempts,
      ...(splitPart ? splitLogContext(splitPart) : {}),
    });
    if (!splitPart) {
      session.earliestPendingTimestamp = null;
    }
    if (splitPart) {
      session.activeSplitPart = null;
      session.splitGroupProgress = null;
    }
    worker?.broadcastProcessingStatus?.();
    return {
      kind: 'invalid',
      empty: !text.trim(),
      retried: retryResult.retried,
      failed: retryResult.failed,
    };
  }

  if (!session.memorySessionId) {
    logger.warn('SDK', 'memorySessionId not yet captured; deferring storage until next round', {
      sessionId: session.sessionDbId
    });
    // Reset any claimed-but-undelivered messages back to pending so they don't
    // count as "in progress" and trigger a respawn loop while we wait for the
    // memory session id to appear. The next generator pass will re-claim them.
    await sessionManager.resetProcessingToPending(session.sessionDbId);
    return { kind: 'deferred', reason: 'missing_memory_session_id' };
  }

  if (text) {
    session.conversationHistory.push({ role: 'assistant', content: text });
  }

  const { observations, summary } = parsed;
  const summaryForStore = normalizeSummaryForStorage(summary);

  const sessionStore = dbManager.getSessionStore();
  sessionStore.ensureMemorySessionIdRegistered(session.sessionDbId, session.memorySessionId);

  logger.info('DB', `STORING | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${observations.length} | hasSummary=${!!summaryForStore}`, {
    sessionId: session.sessionDbId,
    memorySessionId: session.memorySessionId
  });

  const labeledObservations = observations.map(obs => ({
    ...obs,
    agent_type: session.pendingAgentType ?? null,
    agent_id: session.pendingAgentId ?? null
  }));

  let result: ReturnType<typeof sessionStore.storeObservations>;
  try {
    result = sessionStore.storeObservations(
      session.memorySessionId,
      session.project,
      labeledObservations,
      summaryForStore,
      session.lastPromptNumber,
      discoveryTokens,
      originalTimestamp ?? undefined,
      modelId
    );
  } finally {
    session.pendingAgentId = null;
    session.pendingAgentType = null;
  }

  logger.info('DB', `STORED | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${result.observationIds.length} | obsIds=[${result.observationIds.join(',')}] | summaryId=${result.summaryId || 'none'}`, {
    sessionId: session.sessionDbId,
    memorySessionId: session.memorySessionId
  });

  session.lastSummaryStored = result.summaryId !== null;

  if (summary && (summary.skipped || session.lastSummaryStored)) {
    await ingestSummary({
      kind: 'parsed',
      sessionDbId: session.sessionDbId,
      messageId: -1,
      contentSessionId: session.contentSessionId,
      parsed: summary,
    });
  }

  const splitCompletion = splitPart
    ? recordSplitPartSuccess(session, splitPart)
    : { complete: true, completedParts: 1 };

  if (splitPart && !splitCompletion.complete) {
    logger.info('QUEUE', 'Stored split part; deferring claim confirmation until remaining parts finish', {
      sessionDbId: session.sessionDbId,
      completedParts: splitCompletion.completedParts,
      ...splitLogContext(splitPart),
    });
  } else {
    if (splitPart) {
      await sessionManager.confirmClaimedMessageIds(
        session.sessionDbId,
        splitPart.originalSourceIds
      );
    } else {
      await sessionManager.confirmClaimedMessages(session.sessionDbId);
    }
    if (!splitPart) {
      session.earliestPendingTimestamp = null;
    }
    session.restartGuard?.recordSuccess();
    worker?.broadcastProcessingStatus?.();
    if (splitPart) {
      logger.info('QUEUE', 'All split parts stored; confirmed original claimed messages', {
        sessionDbId: session.sessionDbId,
        completedParts: splitCompletion.completedParts,
        ...splitLogContext(splitPart),
      });
      session.activeSplitPart = null;
      session.splitGroupProgress = null;
    }
  }

  void notifyTelegram({
    observations: labeledObservations,
    observationIds: result.observationIds,
    project: session.project,
    memorySessionId: session.memorySessionId,
  });

  await syncAndBroadcastObservations(
    observations,
    result,
    session,
    dbManager,
    worker,
    discoveryTokens,
    agentName,
    projectRoot
  );

  await syncAndBroadcastSummary(
    summary,
    summaryForStore,
    result,
    session,
    dbManager,
    worker,
    discoveryTokens,
    agentName
  );

  return {
    kind: 'stored',
    observationCount: observations.length,
    summaryStored: !!result.summaryId,
  };
}

function hasStoredPreviousSplitPart(
  session: ActiveSession,
  splitPart: SplitDrainMetadata
): boolean {
  return !!session.splitGroupProgress &&
    session.splitGroupProgress.splitGroupId === splitPart.splitGroupId &&
    session.splitGroupProgress.completedParts > 0;
}

function recordSplitPartSuccess(
  session: ActiveSession,
  splitPart: SplitDrainMetadata
): { complete: boolean; completedParts: number } {
  if (
    !session.splitGroupProgress ||
    session.splitGroupProgress.splitGroupId !== splitPart.splitGroupId
  ) {
    session.splitGroupProgress = {
      splitGroupId: splitPart.splitGroupId,
      splitTotal: splitPart.splitTotal,
      completedParts: 0,
      originalSourceIds: [...splitPart.originalSourceIds],
    };
  }

  session.splitGroupProgress.completedParts = Math.max(
    session.splitGroupProgress.completedParts + 1,
    splitPart.splitIndex
  );

  return {
    complete: session.splitGroupProgress.completedParts >= session.splitGroupProgress.splitTotal,
    completedParts: session.splitGroupProgress.completedParts,
  };
}

function splitLogContext(splitPart: SplitDrainMetadata): Record<string, unknown> {
  return {
    splitGroupId: splitPart.splitGroupId,
    splitIndex: splitPart.splitIndex,
    splitTotal: splitPart.splitTotal,
    originalSourceIds: splitPart.originalSourceIds,
    parentMessageType: splitPart.parentMessageType,
  };
}

function normalizeSummaryForStorage(summary: ParsedSummary | null): {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
} | null {
  if (!summary) return null;
  if (summary.skipped) return null;

  return {
    request: summary.request || '',
    investigated: summary.investigated || '',
    learned: summary.learned || '',
    completed: summary.completed || '',
    next_steps: summary.next_steps || '',
    notes: summary.notes
  };
}

async function syncAndBroadcastObservations(
  observations: ParsedObservation[],
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  agentName: string,
  projectRoot?: string
): Promise<void> {
  // Dedupe observation IDs before sync/broadcast: storeObservations may collapse
  // multiple parsed observations onto the same row via content_hash, producing
  // duplicate IDs. Syncing them 1:1 triggers repeated Chroma "IDs already exist"
  // reconciles. See issue #2240.
  const uniqueObservationIds = [...new Set(result.observationIds)];

  for (const obsId of uniqueObservationIds) {
    const observationIndex = result.observationIds.indexOf(obsId);
    const obs = observations[observationIndex];
    if (!obs) {
      logger.warn('DB', `${agentName} storage returned observation id without matching parsed observation`, {
        sessionId: session.sessionDbId,
        obsId,
        observationIndex
      });
      continue;
    }
    const chromaStart = Date.now();

    dbManager.getChromaSync()?.syncObservation(
      obsId,
      session.contentSessionId,
      session.project,
      obs,
      session.lastPromptNumber,
      result.createdAtEpoch,
      discoveryTokens
    ).then(() => {
      const chromaDuration = Date.now() - chromaStart;
      logger.debug('CHROMA', 'Observation synced', {
        obsId,
        duration: `${chromaDuration}ms`,
        type: obs.type,
        title: obs.title || '(untitled)'
      });
    }).catch((error) => {
      logger.error('CHROMA', `${agentName} chroma sync failed, continuing without vector search`, {
        obsId,
        type: obs.type,
        title: obs.title || '(untitled)'
      }, error);
    });

    broadcastObservation(worker, {
      id: obsId,
      memory_session_id: session.memorySessionId,
      session_id: session.contentSessionId,
      platform_source: session.platformSource,
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      text: null,
      narrative: obs.narrative || null,
      facts: JSON.stringify(obs.facts || []),
      concepts: JSON.stringify(obs.concepts || []),
      files_read: JSON.stringify(obs.files_read || []),
      files_modified: JSON.stringify(obs.files_modified || []),
      project: session.project,
      prompt_number: session.lastPromptNumber,
      created_at_epoch: result.createdAtEpoch
    });
  }

  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const settingValue: unknown = settings.CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED;
  const folderClaudeMdEnabled = settingValue === 'true' || settingValue === true;

  if (folderClaudeMdEnabled) {
    const allFilePaths: string[] = [];
    for (const obs of observations) {
      allFilePaths.push(...(obs.files_modified || []));
      allFilePaths.push(...(obs.files_read || []));
    }

    if (allFilePaths.length > 0) {
      updateFolderClaudeMdFiles(
        allFilePaths,
        session.project,
        getWorkerPort(),
        projectRoot
      ).catch(error => {
        logger.warn('FOLDER_INDEX', 'CLAUDE.md update failed (non-critical)', { project: session.project }, error as Error);
      });
    }
  }
}

async function syncAndBroadcastSummary(
  summary: ParsedSummary | null,
  summaryForStore: { request: string; investigated: string; learned: string; completed: string; next_steps: string; notes: string | null } | null,
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  agentName: string
): Promise<void> {
  if (!summaryForStore || !result.summaryId) {
    return;
  }

  const chromaStart = Date.now();

  dbManager.getChromaSync()?.syncSummary(
    result.summaryId,
    session.contentSessionId,
    session.project,
    summaryForStore,
    session.lastPromptNumber,
    result.createdAtEpoch,
    discoveryTokens
  ).then(() => {
    const chromaDuration = Date.now() - chromaStart;
    logger.debug('CHROMA', 'Summary synced', {
      summaryId: result.summaryId,
      duration: `${chromaDuration}ms`,
      request: summaryForStore.request || '(no request)'
    });
  }).catch((error) => {
    logger.error('CHROMA', `${agentName} chroma sync failed, continuing without vector search`, {
      summaryId: result.summaryId,
      request: summaryForStore.request || '(no request)'
    }, error);
  });

  broadcastSummary(worker, {
    id: result.summaryId,
    session_id: session.contentSessionId,
    platform_source: session.platformSource,
    request: summaryForStore!.request,
    investigated: summaryForStore!.investigated,
    learned: summaryForStore!.learned,
    completed: summaryForStore!.completed,
    next_steps: summaryForStore!.next_steps,
    notes: summaryForStore!.notes,
    project: session.project,
    prompt_number: session.lastPromptNumber,
    created_at_epoch: result.createdAtEpoch
  });

  updateCursorContextForProject(session.project, getWorkerPort()).catch(error => {
    logger.warn('CURSOR', 'Context update failed (non-critical)', { project: session.project }, error as Error);
  });
}
