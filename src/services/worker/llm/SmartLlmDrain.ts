import type { PendingMessageWithId } from '../../worker-types.js';

export interface SmartLlmDrainOptions {
  mode: 'off' | 'auto' | 'local_safe';
  maxBatchItems: number;
  maxBatchChars: number;
  coalesceWindowMs: number;
  minSendIntervalMs: number;
  highWatermark: number;
  criticalWatermark: number;
  maxAttempts: number;
  adaptiveBackoff: boolean;
  dropPolicy: string;
  metricsEnabled: boolean;
  contextSplit: SmartLlmContextSplitOptions;
}

export interface SmartLlmContextSplitOptions {
  enabled: boolean;
  maxChars: number;
  maxParts: number;
}

export interface SplitDrainMetadata {
  splitGroupId: string;
  splitIndex: number;
  splitTotal: number;
  originalSourceIds: number[];
  parentMessageType: string;
  reason: 'context_limit';
}

export interface SmartLlmDrainMetrics {
  mode: SmartLlmDrainOptions['mode'];
  minSendIntervalMs: number;
  currentBackoffMs: number;
  currentMaxBatchItems: number;
  lastLatencyMs: number;
  emptyResponseCount: number;
  parserFailureCount: number;
  timeoutCount: number;
  healthyResponseCount: number;
}

export type DrainItem =
  | { kind: 'single'; message: PendingMessageWithId; sourceIds: number[]; priority: number; splitMetadata?: SplitDrainMetadata }
  | { kind: 'batch'; messages: PendingMessageWithId[]; sourceIds: number[]; syntheticTitle: string; syntheticBody: string; priority: number; splitMetadata?: SplitDrainMetadata }
  | { kind: 'coalesced'; messages: PendingMessageWithId[]; sourceIds: number[]; syntheticTitle: string; syntheticBody: string; priority: number; splitMetadata?: SplitDrainMetadata };

export interface SmartLlmDrainDependencies {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  getQueueDepth?: () => number | Promise<number>;
  onMetrics?: (metrics: SmartLlmDrainMetrics) => void;
}

const LOW_VALUE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'ListMcpResourcesTool']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export class SmartLlmDrain {
  private currentDelayMs: number;
  private currentMaxBatchItems: number;
  private lastLatencyMs = 0;
  private consecutiveTimeouts = 0;
  private consecutiveEmptyResponses = 0;
  private consecutiveParserFailures = 0;
  private healthyResponses = 0;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly getQueueDepth?: () => number | Promise<number>;
  private readonly onMetrics?: (metrics: SmartLlmDrainMetrics) => void;

  constructor(
    private readonly options: SmartLlmDrainOptions,
    deps: SmartLlmDrainDependencies = {}
  ) {
    this.currentDelayMs = options.minSendIntervalMs;
    this.currentMaxBatchItems = options.maxBatchItems;
    this.sleep = deps.sleep ?? defaultSleep;
    this.getQueueDepth = deps.getQueueDepth;
    this.onMetrics = deps.onMetrics;
    this.publishMetrics();
  }

  async *drain(
    input: AsyncIterable<PendingMessageWithId>,
    signal?: AbortSignal
  ): AsyncIterableIterator<DrainItem> {
    const iterator = input[Symbol.asyncIterator]();
    let buffered: PendingMessageWithId | null = null;

    const nextMessage = async (): Promise<PendingMessageWithId | null> => {
      if (buffered) {
        const value = buffered;
        buffered = null;
        return value;
      }
      const result = await iterator.next();
      return result.done ? null : result.value;
    };

    while (!signal?.aborted) {
      const first = await nextMessage();
      if (!first) return;

      const firstPriority = classifyPriority(first);
      if (this.options.mode === 'off' || !isBatchable(first, firstPriority)) {
        await this.waitBeforeYield(signal);
        yield { kind: 'single', message: first, sourceIds: [first._persistentId], priority: firstPriority };
        continue;
      }

      const group = [first];
      const queueDepth = await this.readQueueDepth();
      const shouldCoalesce = queueDepth >= this.options.highWatermark && isCoalescible(first);
      while (group.length < this.currentMaxBatchItems) {
        const next = await nextMessage();
        if (!next) break;
        const nextPriority = classifyPriority(next);
        const compatible = shouldCoalesce
          ? isSameNoiseSource(first, next)
          : isBatchable(next, nextPriority);
        if (!compatible || exceedsCharBudget([...group, next], this.options.maxBatchChars)) {
          buffered = next;
          break;
        }
        group.push(next);
      }

      await this.waitBeforeYield(signal);
      if (group.length === 1) {
        yield { kind: 'single', message: first, sourceIds: [first._persistentId], priority: firstPriority };
      } else if (shouldCoalesce) {
        yield {
          kind: 'coalesced',
          messages: group,
          sourceIds: sourceIds(group),
          syntheticTitle: `${first.tool_name ?? 'Tool'} repeated ${group.length} times`,
          syntheticBody: buildSyntheticBody(group),
          priority: Math.min(...group.map(classifyPriority)),
        };
      } else {
        yield {
          kind: 'batch',
          messages: group,
          sourceIds: sourceIds(group),
          syntheticTitle: `Batch of ${group.length} queued observations`,
          syntheticBody: buildSyntheticBody(group),
          priority: Math.max(...group.map(classifyPriority)),
        };
      }
      this.publishMetrics();
    }
  }

  recordProviderSuccess(latencyMs: number): void {
    this.lastLatencyMs = Math.max(0, latencyMs);
    this.healthyResponses++;
    this.consecutiveTimeouts = 0;
    this.consecutiveEmptyResponses = 0;
    this.consecutiveParserFailures = 0;
    if (this.options.adaptiveBackoff) {
      const decreaseBy = Math.max(100, Math.floor(this.currentDelayMs * 0.25));
      this.currentDelayMs = Math.max(this.options.minSendIntervalMs, this.currentDelayMs - decreaseBy);
      this.currentMaxBatchItems = Math.min(this.options.maxBatchItems, this.currentMaxBatchItems + 1);
    }
    this.publishMetrics();
  }

  recordProviderTimeout(_reason: string): void {
    this.consecutiveTimeouts++;
    this.increaseBackoff();
    this.publishMetrics();
  }

  recordProviderEmptyResponse(_reason: string): void {
    this.consecutiveEmptyResponses++;
    this.increaseBackoff();
    this.publishMetrics();
  }

  recordParserFailure(_reason: string): void {
    this.consecutiveParserFailures++;
    this.currentMaxBatchItems = Math.max(1, Math.floor(this.currentMaxBatchItems / 2));
    this.increaseBackoff();
    this.publishMetrics();
  }

  getMetrics(): SmartLlmDrainMetrics {
    return {
      mode: this.options.mode,
      minSendIntervalMs: this.options.minSendIntervalMs,
      currentBackoffMs: this.currentDelayMs,
      currentMaxBatchItems: this.currentMaxBatchItems,
      lastLatencyMs: this.lastLatencyMs,
      emptyResponseCount: this.consecutiveEmptyResponses,
      parserFailureCount: this.consecutiveParserFailures,
      timeoutCount: this.consecutiveTimeouts,
      healthyResponseCount: this.healthyResponses,
    };
  }

  private async waitBeforeYield(signal?: AbortSignal): Promise<void> {
    if (this.options.mode === 'off') return;
    const queueDepth = await this.readQueueDepth();
    const shouldPace = this.options.mode === 'local_safe' || queueDepth >= this.options.highWatermark;
    if (!shouldPace || this.currentDelayMs <= 0) return;
    await this.sleep(this.currentDelayMs, signal);
  }

  private increaseBackoff(): void {
    if (!this.options.adaptiveBackoff) return;
    const base = this.currentDelayMs > 0 ? this.currentDelayMs : Math.max(250, this.options.minSendIntervalMs);
    this.currentDelayMs = Math.min(60_000, Math.max(this.options.minSendIntervalMs, Math.floor(base * 1.5)));
  }

  private publishMetrics(): void {
    this.onMetrics?.(this.getMetrics());
  }

  private async readQueueDepth(): Promise<number> {
    return this.getQueueDepth ? await this.getQueueDepth() : 0;
  }
}

function classifyPriority(message: PendingMessageWithId): number {
  if (message.type === 'summarize') return 100;
  const toolName = message.tool_name ?? '';
  const haystack = `${toolName}\n${safeStringify(message.tool_input)}\n${safeStringify(message.tool_response)}`.toLowerCase();
  if (haystack.includes('error') || haystack.includes('failed') || haystack.includes('traceback') || haystack.includes('permission denied')) {
    return 80;
  }
  if (WRITE_TOOLS.has(toolName) || haystack.includes('migration') || haystack.includes('package install') || haystack.includes('config')) {
    return 70;
  }
  if (toolName === 'Bash') return 50;
  if (toolName === 'Read') return 40;
  if (LOW_VALUE_TOOLS.has(toolName)) return 30;
  return 50;
}

function isBatchable(message: PendingMessageWithId, priority: number): boolean {
  return message.type === 'observation' && priority >= 30 && priority <= 50;
}

function isCoalescible(message: PendingMessageWithId): boolean {
  return message.type === 'observation' && LOW_VALUE_TOOLS.has(message.tool_name ?? '');
}

function isSameNoiseSource(a: PendingMessageWithId, b: PendingMessageWithId): boolean {
  return isCoalescible(b)
    && a.tool_name === b.tool_name
    && safeStringify(a.tool_input) === safeStringify(b.tool_input)
    && (a.cwd ?? '') === (b.cwd ?? '');
}

function exceedsCharBudget(messages: PendingMessageWithId[], maxChars: number): boolean {
  const total = messages.reduce((sum, message) => sum + safeStringify(message).length, 0);
  return total > maxChars;
}

function sourceIds(messages: PendingMessageWithId[]): number[] {
  return messages.map(message => message._persistentId);
}

function buildSyntheticBody(messages: PendingMessageWithId[]): string {
  return messages.map((message, index) => [
    `Source ${index + 1}`,
    `Pending message ID: ${message._persistentId}`,
    `Tool: ${message.tool_name ?? message.type}`,
    `CWD: ${message.cwd ?? 'unknown'}`,
  ].join('\n')).join('\n\n');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}
