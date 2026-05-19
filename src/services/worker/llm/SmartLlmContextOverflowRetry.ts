import type { DrainItem, SmartLlmContextSplitOptions } from './SmartLlmDrain.js';
import { SmartLlmContextSplitter } from './SmartLlmContextSplitter.js';
import { isProviderContextOverflowError } from '../provider-errors.js';

export interface ContextOverflowRetryPlan {
  options: SmartLlmContextSplitOptions;
  parts: DrainItem[];
}

export function buildContextOverflowRetryPlan(
  error: unknown,
  originalItem: DrainItem,
  previousParts: DrainItem[],
  options: SmartLlmContextSplitOptions
): ContextOverflowRetryPlan | null {
  if (!isProviderContextOverflowError(error) || !options.enabled) {
    return null;
  }
  if (previousParts.length !== 1 || previousParts[0].splitMetadata) {
    return null;
  }

  const retryOptions = reduceContextSplitBudget(options);
  const retryParts = new SmartLlmContextSplitter(retryOptions).split(originalItem);
  if (retryParts.length <= 1) {
    return null;
  }

  return {
    options: retryOptions,
    parts: retryParts,
  };
}

export function reduceContextSplitBudget(options: SmartLlmContextSplitOptions): SmartLlmContextSplitOptions {
  return {
    ...options,
    enabled: true,
    maxChars: Math.max(1_000, Math.floor(options.maxChars / 2)),
    maxParts: Math.min(100, Math.max(options.maxParts + 1, options.maxParts * 2)),
  };
}
