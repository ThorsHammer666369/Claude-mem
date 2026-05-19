import { describe, expect, test } from 'bun:test';
import type { PendingMessageWithId } from '../../../../src/services/worker-types.js';
import type { DrainItem, SmartLlmContextSplitOptions } from '../../../../src/services/worker/llm/SmartLlmDrain.js';
import { buildObservationPromptFromDrainItem } from '../../../../src/services/worker/llm/SmartLlmDrainPromptBuilder.js';
import { SmartLlmContextSplitter } from '../../../../src/services/worker/llm/SmartLlmContextSplitter.js';

const splitOptions: SmartLlmContextSplitOptions = {
  enabled: true,
  maxChars: 900,
  maxParts: 10,
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
    prompt_number: 7,
    cwd: 'C:/repo',
    _persistentId: id,
    _originalTimestamp: 1_700_000_000_000 + id,
    ...overrides,
  };
}

function single(message: PendingMessageWithId, priority = 50): DrainItem {
  return {
    kind: 'single',
    message,
    sourceIds: [message._persistentId],
    priority,
  };
}

function lineOutput(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix} line ${index + 1}`).join('\n');
}

function expectPromptBudgetWhenFeasible(parts: DrainItem[], maxChars: number): void {
  for (const part of parts) {
    const emptyPrompt = part.kind === 'single'
      ? buildObservationPromptFromDrainItem({
        ...part,
        message: {
          ...part.message,
          tool_response: typeof part.message.tool_response === 'string'
            ? ''
            : { ...part.message.tool_response, stdout: '', stderr: '', output: '' },
        },
      }, 1_700_000_000_000)
      : '';
    if (emptyPrompt.length <= maxChars) {
      expect(buildObservationPromptFromDrainItem(part, 1_700_000_000_000).length).toBeLessThanOrEqual(maxChars);
    }
  }
}

describe('SmartLlmContextSplitter', () => {
  test('returns the original item unchanged when splitting is disabled', () => {
    const item = single(observation(101, 'Bash', {
      tool_response: { stdout: lineOutput('disabled', 80) },
    }));
    const splitter = new SmartLlmContextSplitter({
      ...splitOptions,
      enabled: false,
      maxChars: 200,
    });

    const parts = splitter.split(item);

    expect(parts).toEqual([item]);
  });

  test('splits an oversized single observation and exposes stable split metadata in prompts', () => {
    const item = single(observation(102, 'Bash', {
      tool_response: { stdout: lineOutput('observation', 80) },
    }));
    const splitter = new SmartLlmContextSplitter(splitOptions);

    const parts = splitter.split(item);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.kind === 'single')).toBe(true);
    expect(parts.every(part => part.sourceIds.join(',') === '102')).toBe(true);
    expect(parts.every(part => part.priority === item.priority)).toBe(true);

    const first = parts[0];
    expect(first.splitMetadata).toEqual({
      splitGroupId: 'context-102-single-observation',
      splitIndex: 1,
      splitTotal: parts.length,
      originalSourceIds: [102],
      parentMessageType: 'observation',
      reason: 'context_limit',
    });

    const prompt = buildObservationPromptFromDrainItem(first, 1_700_000_000_000);
    expect(prompt).toContain('context-102-single-observation');
    expect(prompt).toContain('"splitIndex": 1');
    expect(prompt).toContain('"splitTotal":');
    expect(prompt).toContain('"originalSourceIds": [');
    expect(prompt).toContain('context_limit');
  });

  test('splits oversized command output by line windows', () => {
    const item = single(observation(103, 'Bash', {
      tool_input: { command: 'npm test' },
      tool_response: { stdout: lineOutput('command', 120), stderr: '' },
    }));
    const splitter = new SmartLlmContextSplitter({
      ...splitOptions,
      maxChars: 1600,
      maxParts: 20,
    });

    const parts = splitter.split(item);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.kind === 'single')).toBe(true);
    expect(JSON.stringify(parts[0].message.tool_response)).toContain('command line 1');
    expect(JSON.stringify(parts[parts.length - 1].message.tool_response)).toContain('command line 120');
    expect(parts.every(part => part.sourceIds.join(',') === '103')).toBe(true);
  });

  test('splits oversized file-read output by line windows and keeps read metadata', () => {
    const item = single(observation(104, 'Read', {
      tool_input: { file_path: 'src/large.ts' },
      tool_response: lineOutput('file', 140),
    }), 40);
    const splitter = new SmartLlmContextSplitter({
      ...splitOptions,
      maxChars: 1600,
      maxParts: 30,
    });

    const parts = splitter.split(item);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.kind === 'single')).toBe(true);
    expect(parts.every(part => part.priority === 40)).toBe(true);
    expect(parts.every(part => JSON.stringify(part.message.tool_input).includes('src/large.ts'))).toBe(true);
    expect(JSON.stringify(parts[0].message.tool_response)).toContain('file line 1');
    expect(JSON.stringify(parts[parts.length - 1].message.tool_response)).toContain('file line 140');
  });

  test('splits protected error output without downgrading priority or source ids', () => {
    const item = single(observation(105, 'Bash', {
      tool_response: { stderr: lineOutput('Error: failed traceback', 100), exitCode: 1 },
    }), 80);
    const splitter = new SmartLlmContextSplitter({
      ...splitOptions,
      maxChars: 1200,
      maxParts: 20,
    });

    const parts = splitter.split(item);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.priority === 80)).toBe(true);
    expect(parts.every(part => part.sourceIds.join(',') === '105')).toBe(true);
    expect(parts.every(part => part.splitMetadata?.originalSourceIds.join(',') === '105')).toBe(true);
    expect(JSON.stringify(parts[0].message.tool_response)).toContain('Error: failed traceback line 1');
  });

  test('splits mixed command error stderr when stdout is empty and keeps metadata under budget when feasible', () => {
    const maxChars = 1200;
    const item = single(observation(106, 'Bash', {
      tool_input: { command: 'npm test' },
      tool_response: {
        stdout: '',
        stderr: lineOutput('stderr failure', 80),
        exitCode: 1,
      },
    }), 80);
    const splitter = new SmartLlmContextSplitter({
      ...splitOptions,
      maxChars,
    });

    const parts = splitter.split(item);

    expect(parts.length).toBeGreaterThan(0);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.kind === 'single')).toBe(true);
    expect(parts.every(part => part.sourceIds.join(',') === '106')).toBe(true);
    expect(parts.every(part => part.priority === 80)).toBe(true);
    expect(parts.every(part => part.message.tool_response.exitCode === 1)).toBe(true);
    expect(JSON.stringify(parts[0].message.tool_response)).toContain('stderr failure line 1');
    expect(JSON.stringify(parts[parts.length - 1].message.tool_response)).toContain('stderr failure line 80');
    expectPromptBudgetWhenFeasible(parts, maxChars);
  });

  test('does not repeat a full oversized stderr payload on every split part when stdout is empty', () => {
    const stderr = lineOutput('repeated stderr', 80);
    const item = single(observation(107, 'Bash', {
      tool_response: {
        stdout: '',
        stderr,
        exitCode: 1,
      },
    }), 80);
    const splitter = new SmartLlmContextSplitter({
      ...splitOptions,
      maxChars: 1200,
    });

    const parts = splitter.split(item);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(JSON.stringify(part.message.tool_response)).not.toContain(stderr);
    }
  });

  test('splits oversized stderr instead of short stdout in structured command output', () => {
    const maxChars = 1200;
    const stderr = lineOutput('structured stderr', 80);
    const item = single(observation(108, 'Bash', {
      tool_input: { command: 'npm test' },
      tool_response: {
        stdout: 'short stdout',
        stderr,
        exitCode: 1,
      },
    }), 80);
    const splitter = new SmartLlmContextSplitter({
      ...splitOptions,
      maxChars,
      maxParts: 20,
    });

    const parts = splitter.split(item);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.kind === 'single')).toBe(true);
    expect(parts.every(part => part.sourceIds.join(',') === '108')).toBe(true);
    expect(parts.every(part => part.priority === 80)).toBe(true);
    expect(parts.every(part => part.message.tool_response.exitCode === 1)).toBe(true);
    for (const part of parts) {
      expect(JSON.stringify(part.message.tool_response)).not.toContain(stderr);
    }
    expect(JSON.stringify(parts[0].message.tool_response)).toContain('structured stderr line 1');
    expect(JSON.stringify(parts[parts.length - 1].message.tool_response)).toContain('structured stderr line 80');
    expectPromptBudgetWhenFeasible(parts, maxChars);
  });

  test('splits oversized stderr ahead of longer non-error stdout in structured command output', () => {
    const maxChars = 1200;
    const stdout = lineOutput('informational stdout noise', 120);
    const stderr = lineOutput('stderr failure', 80);
    expect(stdout.length).toBeGreaterThan(stderr.length);
    const item = single(observation(109, 'Bash', {
      tool_input: { command: 'npm test' },
      tool_response: {
        stdout,
        stderr,
        exitCode: 1,
      },
    }), 80);
    const splitter = new SmartLlmContextSplitter({
      ...splitOptions,
      maxChars,
      maxParts: 60,
    });

    const parts = splitter.split(item);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.kind === 'single')).toBe(true);
    expect(parts.every(part => part.sourceIds.join(',') === '109')).toBe(true);
    expect(parts.every(part => part.priority === 80)).toBe(true);
    expect(parts.every(part => part.message.tool_response.exitCode === 1)).toBe(true);
    for (const part of parts) {
      expect(JSON.stringify(part.message.tool_response)).not.toContain(stderr);
    }
    const combinedResponses = parts.map(part => JSON.stringify(part.message.tool_response)).join('\n');
    expect(combinedResponses).toContain('stderr failure line 1');
    expect(combinedResponses).toContain('stderr failure line 80');
    expectPromptBudgetWhenFeasible(parts, maxChars);
  });

  test('splits oversized stdout when stderr is short and non-empty', () => {
    const maxChars = 1600;
    const stdout = lineOutput('stdout preserved', 80);
    const stderr = 'warning only';
    const item = single(observation(110, 'Bash', {
      tool_input: { command: 'npm test' },
      tool_response: {
        stdout,
        stderr,
        exitCode: 1,
      },
    }), 80);
    const splitter = new SmartLlmContextSplitter({
      ...splitOptions,
      maxChars,
      maxParts: 30,
    });

    const parts = splitter.split(item);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.kind === 'single')).toBe(true);
    expect(parts.every(part => part.sourceIds.join(',') === '110')).toBe(true);
    expect(parts.every(part => part.priority === 80)).toBe(true);
    expect(parts.every(part => part.message.tool_response.exitCode === 1)).toBe(true);
    for (const part of parts) {
      const response = JSON.stringify(part.message.tool_response);
      expect(response).not.toContain(stdout);
      expect(response).toContain(stderr);
    }
    const combinedResponses = parts.map(part => JSON.stringify(part.message.tool_response)).join('\n');
    expect(combinedResponses).toContain('stdout preserved line 1');
    expect(combinedResponses).toContain('stdout preserved line 80');
    expectPromptBudgetWhenFeasible(parts, maxChars);
  });

  test('splits oversized stdout at higher budget when stderr is short and non-empty', () => {
    const maxChars = 1200;
    const stdout = lineOutput('stdout preserved', 80);
    const stderr = 'warning only';
    const item = single(observation(111, 'Bash', {
      tool_input: { command: 'npm test' },
      tool_response: {
        stdout,
        stderr,
        exitCode: 1,
      },
    }), 80);
    const splitter = new SmartLlmContextSplitter({
      ...splitOptions,
      maxChars,
      maxParts: 30,
    });

    const parts = splitter.split(item);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.sourceIds.join(',') === '111')).toBe(true);
    expect(parts.every(part => part.priority === 80)).toBe(true);
    expect(parts.every(part => part.message.tool_response.exitCode === 1)).toBe(true);
    for (const part of parts) {
      const response = JSON.stringify(part.message.tool_response);
      expect(response).not.toContain(stdout);
      expect(response).toContain(stderr);
    }
    const combinedResponses = parts.map(part => JSON.stringify(part.message.tool_response)).join('\n');
    expect(combinedResponses).toContain('stdout preserved line 1');
    expect(combinedResponses).toContain('stdout preserved line 80');
    expectPromptBudgetWhenFeasible(parts, maxChars);
  });

  test('returns original item when max parts cannot produce sendable chunks', () => {
    const item = single(observation(112, 'Bash', {
      tool_input: { command: 'npm test' },
      tool_response: { stdout: lineOutput('too large for max parts', 300), stderr: '' },
    }), 80);
    const splitter = new SmartLlmContextSplitter({
      ...splitOptions,
      maxChars: 1000,
      maxParts: 3,
    });

    const parts = splitter.split(item);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe(item);
    expect(parts[0].splitMetadata).toBeUndefined();
  });

  test('returns original item when oversized observation has no splittable response content', () => {
    const item = single(observation(114, 'Bash', {
      tool_input: { command: lineOutput('large command input', 60) },
      tool_response: '',
    }), 80);
    const splitter = new SmartLlmContextSplitter({
      ...splitOptions,
      maxChars: 500,
    });

    expect(buildObservationPromptFromDrainItem(item, 1_700_000_000_000).length).toBeGreaterThan(500);

    const parts = splitter.split(item);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe(item);
    expect(parts[0].splitMetadata).toBeUndefined();
  });

  test('returns original item when oversized structured response has no recognized splittable field', () => {
    const item = single(observation(115, 'Bash', {
      tool_input: { command: 'node inspect-large-object.js' },
      tool_response: {
        data: {
          rows: Array.from({ length: 120 }, (_, index) => ({
            index,
            payload: lineOutput(`nested payload ${index}`, 4),
          })),
        },
      },
    }), 80);
    const splitter = new SmartLlmContextSplitter({
      ...splitOptions,
      maxChars: 900,
      maxParts: 30,
    });

    expect(buildObservationPromptFromDrainItem(item, 1_700_000_000_000).length).toBeGreaterThan(900);

    const parts = splitter.split(item);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe(item);
    expect(parts[0].splitMetadata).toBeUndefined();
  });

  test('represents both oversized structured stdout and stderr or returns original conservatively', () => {
    const stdout = lineOutput('dual stdout', 80);
    const stderr = lineOutput('dual stderr', 80);
    const item = single(observation(113, 'Bash', {
      tool_input: { command: 'npm test' },
      tool_response: {
        stdout,
        stderr,
        exitCode: 1,
      },
    }), 80);
    const splitter = new SmartLlmContextSplitter({
      ...splitOptions,
      maxChars: 1200,
      maxParts: 40,
    });

    const parts = splitter.split(item);
    const returnedOriginalConservatively = parts.length === 1
      && parts[0] === item
      && parts[0].splitMetadata === undefined;

    if (!returnedOriginalConservatively) {
      const combinedResponses = parts.map(part => JSON.stringify(part.message.tool_response)).join('\n');
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.every(part => part.sourceIds.join(',') === '113')).toBe(true);
      expect(parts.every(part => part.priority === 80)).toBe(true);
      expect(parts.every(part => part.message.tool_response.exitCode === 1)).toBe(true);
      expect(combinedResponses).not.toContain('omitted from');
      expect(combinedResponses).toContain('dual stdout line 1');
      expect(combinedResponses).toContain('dual stdout line 80');
      expect(combinedResponses).toContain('dual stderr line 1');
      expect(combinedResponses).toContain('dual stderr line 80');
    }

    expect(returnedOriginalConservatively || parts.length > 1).toBe(true);
  });

  test('splits oversized batches by source boundaries before line windows', () => {
    const first = observation(201, 'Read', {
      tool_input: { file_path: 'src/a.ts' },
      tool_response: lineOutput('a', 8),
    });
    const second = observation(202, 'Read', {
      tool_input: { file_path: 'src/b.ts' },
      tool_response: lineOutput('b', 8),
    });
    const item: DrainItem = {
      kind: 'batch',
      messages: [first, second],
      sourceIds: [201, 202],
      syntheticTitle: 'Batch of 2 queued observations',
      syntheticBody: 'large synthetic body that should not be the primary split boundary',
      priority: 40,
    };
    const splitter = new SmartLlmContextSplitter({
      ...splitOptions,
      maxChars: 1050,
    });

    const parts = splitter.split(item);

    expect(parts).toHaveLength(2);
    expect(parts.map(part => part.sourceIds)).toEqual([[201], [202]]);
    expect(parts.every(part => part.kind === 'single')).toBe(true);
    expect(parts.every(part => part.splitMetadata?.originalSourceIds.join(',') === '201,202')).toBe(true);
  });

  test('preserves all source ids conservatively when source boundary candidates exceed max parts', () => {
    const messages = [301, 302, 303, 304].map(id => observation(id, 'Read', {
      tool_input: { file_path: `src/${id}.ts` },
      tool_response: lineOutput(String(id), 8),
    }));
    const item: DrainItem = {
      kind: 'batch',
      messages,
      sourceIds: messages.map(message => message._persistentId),
      syntheticTitle: 'Batch of 4 queued observations',
      syntheticBody: 'source boundary candidates exceed max parts',
      priority: 40,
    };
    const splitter = new SmartLlmContextSplitter({
      ...splitOptions,
      maxChars: 1000,
      maxParts: 3,
    });

    const parts = splitter.split(item);
    const representedSourceIds = new Set(parts.flatMap(part => part.sourceIds));
    const allSourcesRepresented = item.sourceIds.every(sourceId => representedSourceIds.has(sourceId));
    const returnedOriginalConservatively = parts.length === 1
      && parts[0] === item
      && parts[0].splitMetadata === undefined;

    expect(allSourcesRepresented || returnedOriginalConservatively).toBe(true);
  });
});
