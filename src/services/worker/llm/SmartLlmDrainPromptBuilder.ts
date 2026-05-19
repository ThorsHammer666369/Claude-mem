import { buildObservationPrompt } from '../../../sdk/prompts.js';
import type { PendingMessageWithId } from '../../worker-types.js';
import type { DrainItem } from './SmartLlmDrain.js';

export function buildObservationPromptFromDrainItem(
  item: DrainItem,
  createdAtEpoch: number
): string {
  if (item.kind === 'single') {
    return buildPromptForMessage(item.message, createdAtEpoch, item);
  }

  return buildObservationPrompt({
    id: 0,
    tool_name: item.kind === 'coalesced'
      ? 'Queued observation coalesced batch'
      : 'Queued observation batch',
    tool_input: JSON.stringify({
      sourceIds: item.sourceIds,
      splitMetadata: item.splitMetadata,
      instruction: [
        `This is a batch of ${item.sourceIds.length} queued observations from one session.`,
        'Create separate structured observations for each numbered source item.',
        'Do not merge unrelated failures.',
        'Return valid parser-compatible XML only.',
        'Preserve source IDs in the observation facts or narrative when useful.',
      ].join(' '),
    }),
    tool_output: item.syntheticBody,
    created_at_epoch: createdAtEpoch,
    cwd: getDrainItemCwd(item),
  });
}

export function getDrainItemMessages(item: DrainItem): PendingMessageWithId[] {
  return item.kind === 'single' ? [item.message] : item.messages;
}

export function getDrainItemCwd(item: DrainItem): string | undefined {
  return getDrainItemMessages(item).find(message => message.cwd)?.cwd;
}

export function getDrainItemPromptNumber(item: DrainItem): number | undefined {
  const promptNumbers = getDrainItemMessages(item)
    .map(message => message.prompt_number)
    .filter((value): value is number => value !== undefined);
  return promptNumbers.length > 0 ? Math.max(...promptNumbers) : undefined;
}

export function getDrainItemAgentMetadata(item: DrainItem): {
  agentId: string | null;
  agentType: string | null;
} {
  const messages = getDrainItemMessages(item);
  const agentIds = uniqueValues(messages.map(message => message.agentId ?? null));
  const agentTypes = uniqueValues(messages.map(message => message.agentType ?? null));
  return {
    agentId: agentIds.length === 1 ? agentIds[0] : null,
    agentType: agentTypes.length === 1 ? agentTypes[0] : null,
  };
}

function buildPromptForMessage(message: PendingMessageWithId, createdAtEpoch: number, item: DrainItem): string {
  if (message.type !== 'observation') {
    throw new Error('Cannot build observation prompt for a non-observation message');
  }

  return buildObservationPrompt({
    id: 0,
    tool_name: message.tool_name!,
    tool_input: JSON.stringify(item.splitMetadata
      ? { ...toObject(message.tool_input), splitMetadata: item.splitMetadata }
      : message.tool_input),
    tool_output: JSON.stringify(message.tool_response),
    created_at_epoch: createdAtEpoch,
    cwd: message.cwd,
  });
}

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

function uniqueValues<T>(values: T[]): T[] {
  return [...new Set(values)];
}
