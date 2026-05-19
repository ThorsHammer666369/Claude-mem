import type { SettingsDefaults } from '../../../shared/SettingsDefaultsManager.js';
import type { SmartLlmDrainOptions } from './SmartLlmDrain.js';

export function parseSmartLlmDrainOptions(settings: Partial<SettingsDefaults>): SmartLlmDrainOptions {
  const highWatermark = readInt(settings.CLAUDE_MEM_QUEUE_HIGH_WATERMARK, 200, 1);
  const rawCritical = readInt(settings.CLAUDE_MEM_QUEUE_CRITICAL_WATERMARK, 1000, 1);
  return {
    mode: parseMode(settings.CLAUDE_MEM_LLM_QUEUE_MODE),
    maxBatchItems: readInt(settings.CLAUDE_MEM_LLM_BATCH_MAX_ITEMS, 3, 1),
    maxBatchChars: readInt(settings.CLAUDE_MEM_LLM_BATCH_MAX_CHARS, 24_000, 1),
    coalesceWindowMs: readInt(settings.CLAUDE_MEM_LLM_COALESCE_WINDOW_MS, 5000, 0),
    minSendIntervalMs: readInt(settings.CLAUDE_MEM_LLM_MIN_SEND_INTERVAL_MS, 0, 0),
    highWatermark,
    criticalWatermark: Math.max(highWatermark, rawCritical),
    maxAttempts: readInt(settings.CLAUDE_MEM_LLM_MAX_ATTEMPTS, 3, 1),
    adaptiveBackoff: settings.CLAUDE_MEM_LLM_ADAPTIVE_BACKOFF !== 'false',
    dropPolicy: settings.CLAUDE_MEM_QUEUE_DROP_POLICY || 'coalesce_low_value',
    metricsEnabled: settings.CLAUDE_MEM_QUEUE_METRICS_ENABLED !== 'false',
    contextSplit: {
      enabled: readBool(settings.CLAUDE_MEM_LLM_CONTEXT_SPLIT_ENABLED, true),
      maxChars: readInt(settings.CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS, 50_000, 1_000, 1_000_000),
      maxParts: readInt(settings.CLAUDE_MEM_LLM_CONTEXT_SPLIT_MAX_PARTS, 20, 1, 100),
    },
  };
}

function parseMode(value: unknown): SmartLlmDrainOptions['mode'] {
  return value === 'off' || value === 'auto' || value === 'local_safe'
    ? value
    : 'auto';
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return fallback;
}

function readInt(value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const rawValue = typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
  const parsed = /^\d+$/.test(rawValue)
    ? Number.parseInt(rawValue, 10)
    : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
