import type { SmartLlmDrainMetrics } from './SmartLlmDrain.js';

export interface SmartLlmDrainMetricsSnapshot extends SmartLlmDrainMetrics {
  provider: string;
  updatedAtEpochMs: number;
}

let latestMetrics: SmartLlmDrainMetricsSnapshot | null = null;

export function recordSmartLlmDrainMetrics(provider: string, metrics: SmartLlmDrainMetrics): void {
  latestMetrics = {
    ...metrics,
    provider,
    updatedAtEpochMs: Date.now(),
  };
}

export function getSmartLlmDrainMetricsSnapshot(): SmartLlmDrainMetricsSnapshot | null {
  return latestMetrics;
}
