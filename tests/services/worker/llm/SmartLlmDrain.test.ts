import { describe, expect, test } from 'bun:test';
import type { PendingMessageWithId } from '../../../../src/services/worker-types.js';
import {
  SmartLlmDrain,
  type SmartLlmDrainOptions,
} from '../../../../src/services/worker/llm/SmartLlmDrain.js';
import { buildObservationPromptFromDrainItem } from '../../../../src/services/worker/llm/SmartLlmDrainPromptBuilder.js';
import { parseSmartLlmDrainOptions } from '../../../../src/services/worker/llm/SmartLlmDrainSettings.js';

const baseOptions: SmartLlmDrainOptions = {
  mode: 'auto',
  maxBatchItems: 3,
  maxBatchChars: 24_000,
  coalesceWindowMs: 5_000,
  minSendIntervalMs: 1_500,
  highWatermark: 200,
  criticalWatermark: 1000,
  maxAttempts: 3,
  adaptiveBackoff: true,
  dropPolicy: 'coalesce_low_value',
  metricsEnabled: true,
  contextSplit: {
    enabled: true,
    maxChars: 50_000,
    maxParts: 20,
  },
};

function observation(
  id: number,
  toolName: string,
  overrides: Partial<PendingMessageWithId> = {}
): PendingMessageWithId {
  return {
    type: 'observation',
    tool_name: toolName,
    tool_input: { path: 'src/example.ts' },
    tool_response: { ok: true },
    prompt_number: 1,
    cwd: 'C:/repo',
    _persistentId: id,
    _originalTimestamp: 1_700_000_000_000 + id,
    ...overrides,
  };
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of items) {
    results.push(item);
  }
  return results;
}

async function* fromArray(items: PendingMessageWithId[]): AsyncIterableIterator<PendingMessageWithId> {
  for (const item of items) {
    yield item;
  }
}

describe('SmartLlmDrain', () => {
  test('mode off yields one single item per source without pacing', async () => {
    const sleeps: number[] = [];
    const drain = new SmartLlmDrain(
      { ...baseOptions, mode: 'off' },
      { sleep: async ms => { sleeps.push(ms); } }
    );

    const items = await collect(drain.drain(fromArray([
      observation(1, 'Read'),
      observation(2, 'Grep'),
    ])));

    expect(items.map(item => item.kind)).toEqual(['single', 'single']);
    expect(items.map(item => item.sourceIds)).toEqual([[1], [2]]);
    expect(sleeps).toEqual([]);
  });

  test('local_safe mode applies pacing before yielding', async () => {
    const sleeps: number[] = [];
    const drain = new SmartLlmDrain(
      { ...baseOptions, mode: 'local_safe', maxBatchItems: 1 },
      { sleep: async ms => { sleeps.push(ms); } }
    );

    await collect(drain.drain(fromArray([observation(1, 'Read')])));

    expect(sleeps).toEqual([1500]);
  });

  test('batches compatible low-value observations and preserves source ids', async () => {
    const drain = new SmartLlmDrain(
      { ...baseOptions, mode: 'auto', minSendIntervalMs: 0 },
      { sleep: async () => {} }
    );

    const items = await collect(drain.drain(fromArray([
      observation(1, 'Read'),
      observation(2, 'Grep'),
      observation(3, 'LS'),
    ])));

    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('batch');
    expect(items[0].sourceIds).toEqual([1, 2, 3]);
  });

  test('does not batch summarize messages or high-value failures', async () => {
    const drain = new SmartLlmDrain(
      { ...baseOptions, mode: 'auto', minSendIntervalMs: 0 },
      { sleep: async () => {} }
    );

    const items = await collect(drain.drain(fromArray([
      observation(1, 'Read'),
      {
        type: 'summarize',
        last_assistant_message: 'done',
        _persistentId: 2,
        _originalTimestamp: 1_700_000_000_002,
      },
      observation(3, 'Bash', { tool_response: { stderr: 'build failed', exitCode: 1 } }),
    ])));

    expect(items.map(item => item.kind)).toEqual(['single', 'single', 'single']);
    expect(items.map(item => item.sourceIds)).toEqual([[1], [2], [3]]);
  });

  test('coalesces repeated low-value reads when queue pressure is high', async () => {
    const drain = new SmartLlmDrain(
      { ...baseOptions, mode: 'auto', minSendIntervalMs: 0 },
      {
        sleep: async () => {},
        getQueueDepth: async () => 250,
      }
    );

    const items = await collect(drain.drain(fromArray([
      observation(1, 'Read', { tool_input: { path: 'src/a.ts' } }),
      observation(2, 'Read', { tool_input: { path: 'src/a.ts' } }),
    ])));

    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('coalesced');
    expect(items[0].sourceIds).toEqual([1, 2]);
  });

  test('adaptive metrics increase delay and shrink batch after failures', () => {
    const drain = new SmartLlmDrain(baseOptions);

    drain.recordProviderEmptyResponse('empty');
    drain.recordParserFailure('non_xml');
    drain.recordProviderTimeout('timeout');

    const metrics = drain.getMetrics();
    expect(metrics.emptyResponseCount).toBe(1);
    expect(metrics.parserFailureCount).toBe(1);
    expect(metrics.timeoutCount).toBe(1);
    expect(metrics.currentBackoffMs).toBeGreaterThan(baseOptions.minSendIntervalMs);
    expect(metrics.currentMaxBatchItems).toBe(1);
  });

  test('success records latency and backs off toward the configured minimum', () => {
    const drain = new SmartLlmDrain(baseOptions);

    drain.recordProviderTimeout('timeout');
    const increased = drain.getMetrics().currentBackoffMs;
    drain.recordProviderSuccess(750);

    const metrics = drain.getMetrics();
    expect(metrics.lastLatencyMs).toBe(750);
    expect(metrics.healthyResponseCount).toBe(1);
    expect(metrics.currentBackoffMs).toBeLessThan(increased);
  });

  test('batch prompt preserves source IDs and requests separate observations', async () => {
    const drain = new SmartLlmDrain(
      { ...baseOptions, mode: 'auto', minSendIntervalMs: 0 },
      { sleep: async () => {} }
    );

    const [item] = await collect(drain.drain(fromArray([
      observation(1, 'Read'),
      observation(2, 'Grep'),
    ])));

    const prompt = buildObservationPromptFromDrainItem(item, Date.now());

    expect(prompt).toContain('This is a batch of 2 queued observations from one session.');
    expect(prompt).toContain('Create separate structured observations for each numbered source item.');
    expect(prompt).toContain('Pending message ID: 1');
    expect(prompt).toContain('Pending message ID: 2');
  });
});

describe('parseSmartLlmDrainOptions', () => {
  test('parses default context split settings', () => {
    const options = parseSmartLlmDrainOptions({});

    expect(options.contextSplit).toEqual({
      enabled: true,
      maxChars: 50_000,
      maxParts: 20,
    });
  });

  test('parses string settings and clamps unsafe values', () => {
    const options = parseSmartLlmDrainOptions({
      CLAUDE_MEM_LLM_QUEUE_MODE: 'local_safe',
      CLAUDE_MEM_LLM_MIN_SEND_INTERVAL_MS: '-1',
      CLAUDE_MEM_LLM_BATCH_MAX_ITEMS: '0',
      CLAUDE_MEM_LLM_BATCH_MAX_CHARS: 'not-a-number',
      CLAUDE_MEM_LLM_COALESCE_WINDOW_MS: '250',
      CLAUDE_MEM_LLM_ADAPTIVE_BACKOFF: 'false',
      CLAUDE_MEM_LLM_MAX_ATTEMPTS: '0',
      CLAUDE_MEM_QUEUE_HIGH_WATERMARK: '20',
      CLAUDE_MEM_QUEUE_CRITICAL_WATERMARK: '10',
      CLAUDE_MEM_QUEUE_DROP_POLICY: 'coalesce_low_value',
      CLAUDE_MEM_QUEUE_METRICS_ENABLED: 'true',
      CLAUDE_MEM_LLM_CONTEXT_SPLIT_ENABLED: 'false',
      CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS: '999',
      CLAUDE_MEM_LLM_CONTEXT_SPLIT_MAX_PARTS: '101',
    });

    expect(options.mode).toBe('local_safe');
    expect(options.minSendIntervalMs).toBe(0);
    expect(options.maxBatchItems).toBe(1);
    expect(options.maxBatchChars).toBe(24_000);
    expect(options.adaptiveBackoff).toBe(false);
    expect(options.maxAttempts).toBe(1);
    expect(options.highWatermark).toBe(20);
    expect(options.criticalWatermark).toBe(20);
    expect(options.contextSplit).toEqual({
      enabled: false,
      maxChars: 1_000,
      maxParts: 100,
    });
  });

  test('clamps context split settings to maximum safe values and falls back on invalid numbers', () => {
    const options = parseSmartLlmDrainOptions({
      CLAUDE_MEM_LLM_CONTEXT_SPLIT_ENABLED: 'not-a-boolean',
      CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS: '1000001',
      CLAUDE_MEM_LLM_CONTEXT_SPLIT_MAX_PARTS: 'not-a-number',
    });

    expect(options.contextSplit).toEqual({
      enabled: true,
      maxChars: 1_000_000,
      maxParts: 20,
    });
  });

  test('treats malformed context split numeric strings as invalid', () => {
    const options = parseSmartLlmDrainOptions({
      CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS: '75000abc',
      CLAUDE_MEM_LLM_CONTEXT_SPLIT_MAX_PARTS: '12abc',
    });

    expect(options.contextSplit).toEqual({
      enabled: true,
      maxChars: 50_000,
      maxParts: 20,
    });
  });
}
);
