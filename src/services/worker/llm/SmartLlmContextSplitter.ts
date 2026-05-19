import type { PendingMessageWithId } from '../../worker-types.js';
import type {
  DrainItem,
  SmartLlmContextSplitOptions,
  SplitDrainMetadata,
} from './SmartLlmDrain.js';
import { buildObservationPromptFromDrainItem } from './SmartLlmDrainPromptBuilder.js';

type SplitCandidate = {
  item: DrainItem;
  content: string;
  contentKey?: string;
  siblingContentKeys?: string[];
};

export class SmartLlmContextSplitter {
  constructor(private readonly options: SmartLlmContextSplitOptions) {}

  split(item: DrainItem): DrainItem[] {
    if (!this.options.enabled || this.isUnderBudget(item)) {
      return [item];
    }

    const originalSourceIds = [...item.sourceIds];
    const groupId = buildSplitGroupId(item);
    const parentMessageType = getParentMessageType(item);
    const candidates = this.splitBySourceBoundary(item);
    const maxParts = Math.max(1, this.options.maxParts);
    if (candidates.length > maxParts) {
      return [item];
    }

    const unsizedParts: DrainItem[] = [];
    for (const candidate of candidates) {
      const remainingParts = maxParts - unsizedParts.length;
      const candidateParts = this.splitCandidateByLines(candidate, remainingParts);
      if (candidateParts.length > remainingParts) {
        return [item];
      }
      unsizedParts.push(...candidateParts);
    }

    if (unsizedParts.length === 0) {
      return [item];
    }

    if (unsizedParts.length <= 1 && this.isUnderBudget(item)) {
      return [item];
    }

    const total = unsizedParts.length;
    const sizedParts: DrainItem[] = unsizedParts.map((part, index) => {
      const splitMetadata: SplitDrainMetadata = {
        splitGroupId: groupId,
        splitIndex: index + 1,
        splitTotal: total,
        originalSourceIds,
        parentMessageType,
        reason: 'context_limit',
      };
      return {
        ...part,
        splitMetadata,
      };
    });

    if (sizedParts.some(part => estimateMinimumPromptChars(part) <= this.options.maxChars && estimatePromptChars(part) > this.options.maxChars)) {
      return [item];
    }

    return sizedParts;
  }

  private splitBySourceBoundary(item: DrainItem): SplitCandidate[] {
    if (item.kind === 'single') {
      return this.buildCandidates(item);
    }

    return item.messages.flatMap(message => this.buildCandidates({
        kind: 'single',
        message,
        sourceIds: [message._persistentId],
        priority: item.priority,
      }));
  }

  private buildCandidates(item: DrainItem): SplitCandidate[] {
    if (item.kind !== 'single') {
      return [{ item, content: safeStringify(item) }];
    }
    const oversizedKeys = getOversizedStringKeys(item.message.tool_response);
    if (oversizedKeys.length > 1 && item.message.tool_response && typeof item.message.tool_response === 'object' && !Array.isArray(item.message.tool_response)) {
      const record = item.message.tool_response as Record<string, unknown>;
      return oversizedKeys.map(key => ({
        item,
        content: record[key] as string,
        contentKey: key,
        siblingContentKeys: oversizedKeys,
      }));
    }
    const splitContent = getMessageSplitContent(item, this.options.maxChars);
    if (!splitContent) {
      return [];
    }
    return [{ item, content: splitContent.content, contentKey: splitContent.key }];
  }

  private splitCandidateByLines(candidate: SplitCandidate, remainingBudget: number): DrainItem[] {
    if (this.isUnderBudget(candidate.item)) {
      return [candidate.item];
    }

    const lines = candidate.content.split(/\r?\n/);
    if (lines.length <= 1) {
      return this.splitCandidateByChars(candidate, remainingBudget);
    }

    const chunks = this.chunkLinesForCandidate(candidate, lines);
    return chunks.map(chunk => replaceMessageContent(candidate.item, chunk, candidate.contentKey, {
      siblingContentKeys: candidate.siblingContentKeys,
    }));
  }

  private chunkLinesForCandidate(candidate: SplitCandidate, lines: string[]): string[] {
    const chunks: string[] = [];
    let current = '';

    for (const line of lines) {
      const next = current.length > 0 ? `${current}\n${line}` : line;
      if (current.length > 0 && !this.candidateChunkFits(candidate, next)) {
        chunks.push(current);
        current = line;
      } else {
        current = next;
      }
    }

    if (current.length > 0) {
      chunks.push(current);
    }
    return chunks;
  }

  private candidateChunkFits(candidate: SplitCandidate, content: string): boolean {
    const part = replaceMessageContent(candidate.item, content, candidate.contentKey, {
      siblingContentKeys: candidate.siblingContentKeys,
    });
    const probe = {
      ...part,
      splitMetadata: part.splitMetadata ?? buildBudgetSplitMetadata(candidate.item, this.options.maxParts),
    };
    if (estimateMinimumPromptChars(probe) > this.options.maxChars) {
      return content.length <= this.chunkBudget(candidate);
    }
    return estimatePromptChars(probe) <= this.options.maxChars;
  }

  private splitCandidateByChars(candidate: SplitCandidate, remainingBudget: number): DrainItem[] {
    const budget = Math.max(1, this.chunkBudget(candidate));
    const chunks: string[] = [];
    let start = 0;
    while (start < candidate.content.length && chunks.length + 1 < remainingBudget) {
      chunks.push(candidate.content.slice(start, start + budget));
      start += budget;
    }
    if (start < candidate.content.length) {
      chunks.push(candidate.content.slice(start));
    }
    return chunks.map(chunk => replaceMessageContent(candidate.item, chunk, candidate.contentKey, {
      siblingContentKeys: candidate.siblingContentKeys,
    }));
  }

  private chunkBudget(candidate: SplitCandidate): number {
    const emptyCandidate = replaceMessageContent(
      candidate.item,
      '',
      candidate.contentKey,
      { siblingContentKeys: candidate.siblingContentKeys }
    );
    const metadataOverhead = estimatePromptChars({
      ...emptyCandidate,
      splitMetadata: emptyCandidate.splitMetadata ?? buildBudgetSplitMetadata(candidate.item, this.options.maxParts),
    });
    const overhead = metadataOverhead <= this.options.maxChars
      ? metadataOverhead + 10
      : estimatePromptChars(emptyCandidate);
    return Math.max(1, this.options.maxChars - overhead);
  }

  private isUnderBudget(item: DrainItem): boolean {
    return estimatePromptChars(item) <= this.options.maxChars;
  }
}

function estimatePromptChars(item: DrainItem): number {
  try {
    return buildObservationPromptFromDrainItem(item, 0).length;
  } catch {
    return safeStringify(item).length;
  }
}

function estimateMinimumPromptChars(item: DrainItem): number {
  if (item.kind !== 'single') {
    return estimatePromptChars({ ...item, syntheticBody: '' });
  }
  return estimatePromptChars({
    ...item,
    message: {
      ...item.message,
      tool_response: emptySplittableResponse(item.message.tool_response),
    },
  });
}

function buildBudgetSplitMetadata(item: DrainItem, maxParts: number): SplitDrainMetadata {
  return {
    splitGroupId: buildSplitGroupId(item),
    splitIndex: Math.max(1, maxParts),
    splitTotal: Math.max(1, maxParts),
    originalSourceIds: [...item.sourceIds],
    parentMessageType: getParentMessageType(item),
    reason: 'context_limit',
  };
}

function emptySplittableResponse(value: unknown): unknown {
  if (typeof value === 'string') {
    return '';
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const key of ['stdout', 'stderr', 'content', 'text', 'output']) {
      if (typeof copy[key] === 'string') {
        copy[key] = '';
      }
    }
    return copy;
  }
  return '';
}

function replaceMessageContent(
  item: DrainItem,
  content: string,
  contentKey?: string,
  options: { omitOversizedSiblingFields?: boolean; siblingContentKeys?: string[] } = {}
): DrainItem {
  if (item.kind !== 'single') {
    return item;
  }

  return {
    ...item,
    message: {
      ...item.message,
      tool_response: replaceToolResponseContent(item.message.tool_response, content, contentKey, options),
    },
  };
}

function replaceToolResponseContent(
  value: unknown,
  content: string,
  contentKey?: string,
  options: { omitOversizedSiblingFields?: boolean; siblingContentKeys?: string[] } = {}
): unknown {
  if (typeof value === 'string') {
    return content;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const key = contentKey ?? chooseContentKey(record);
    const copy: Record<string, unknown> = { ...record, [key]: content };
    if (options.omitOversizedSiblingFields !== false && options.siblingContentKeys) {
      for (const otherKey of options.siblingContentKeys) {
        if (otherKey !== key && typeof copy[otherKey] === 'string') {
          copy[otherKey] = `[${otherKey} split separately; original length ${(record[otherKey] as string).length} chars]`;
        }
      }
    }
    return copy;
  }
  return content;
}

function chooseContentKey(record: Record<string, unknown>): string {
  const populatedStringKeys = ['stdout', 'stderr', 'content', 'text', 'output']
    .filter(key => typeof record[key] === 'string' && (record[key] as string).length > 0)
    .sort((a, b) => (record[b] as string).length - (record[a] as string).length);
  if (populatedStringKeys.length > 0) {
    return populatedStringKeys[0];
  }
  for (const key of ['stdout', 'stderr', 'content', 'text', 'output']) {
    if (typeof record[key] === 'string') {
      return key;
    }
  }
  return 'output';
}

function getOversizedStringKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  const record = value as Record<string, unknown>;
  return ['stderr', 'stdout', 'content', 'text', 'output']
    .filter(key => typeof record[key] === 'string' && (record[key] as string).length > 500);
}

function getMessageSplitContent(item: Extract<DrainItem, { kind: 'single' }>, maxChars: number): { content: string; key?: string } | null {
  const message = item.message;
  const response = message.tool_response;
  if (typeof response === 'string') {
    return { content: response };
  }
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const record = response as Record<string, unknown>;
    const key = chooseContentKeyForBudget(item, record, maxChars);
    if (typeof record[key] === 'string') {
      return { content: record[key] as string, key };
    }
    return null;
  }
  return null;
}

function chooseContentKeyForBudget(item: Extract<DrainItem, { kind: 'single' }>, record: Record<string, unknown>, maxChars: number): string {
  const populatedKeys = ['stderr', 'stdout', 'content', 'text', 'output']
    .filter(key => typeof record[key] === 'string' && (record[key] as string).length > 0);
  for (const key of populatedKeys) {
    if (estimatePromptChars(replaceMessageContent(item, '', key, { omitOversizedSiblingFields: false })) <= maxChars) {
      return key;
    }
  }
  if (typeof record.stderr === 'string' && record.stderr.length > 500) {
    return 'stderr';
  }
  return chooseLargestPromptReductionKey(item, record, populatedKeys);
}

function chooseLargestPromptReductionKey(
  item: Extract<DrainItem, { kind: 'single' }>,
  record: Record<string, unknown>,
  populatedKeys: string[]
): string {
  const originalPromptChars = estimatePromptChars(item);
  let bestKey = populatedKeys[0] ?? chooseContentKey(record);
  let bestReduction = Number.NEGATIVE_INFINITY;
  for (const key of populatedKeys) {
    const reduction = originalPromptChars - estimatePromptChars(
      replaceMessageContent(item, '', key, { omitOversizedSiblingFields: false })
    );
    if (reduction > bestReduction) {
      bestReduction = reduction;
      bestKey = key;
    }
  }
  return bestKey;
}

function buildSplitGroupId(item: DrainItem): string {
  return [
    'context',
    item.sourceIds.join('-'),
    item.kind,
    getParentMessageType(item),
  ].map(segment => sanitizeGroupSegment(segment)).join('-');
}

function getParentMessageType(item: DrainItem): string {
  const messages = item.kind === 'single' ? [item.message] : item.messages;
  const types = [...new Set(messages.map(message => message.type))];
  return types.length === 1 ? types[0] : 'mixed';
}

function sanitizeGroupSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

export type { SplitDrainMetadata };
