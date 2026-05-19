import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';

describe('SessionManager queue integration', () => {
  let db: Database;
  let store: SessionStore;
  let manager: SessionManager;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    store = new SessionStore(db);

    const dbManager = {
      getSessionStore: () => store,
      getSessionById: (sessionDbId: number) => {
        const session = store.getSessionById(sessionDbId);
        if (!session) {
          throw new Error(`Session ${sessionDbId} not found`);
        }
        return session;
      },
    } as unknown as DatabaseManager;

    manager = new SessionManager(dbManager);
  });

  afterEach(async () => {
    await manager.getPendingMessageStore().close();
    db.close();
  });

  test('confirmClaimedMessages only deletes claimed rows and preserves newly queued work', async () => {
    const sessionDbId = store.createSDKSession(
      'content-ack-invariant',
      'test-project',
      'Test prompt'
    );
    manager.initializeSession(sessionDbId);

    await manager.queueObservation(sessionDbId, {
      tool_name: 'FirstTool',
      tool_input: { step: 1 },
      tool_response: { ok: true },
      prompt_number: 1,
      toolUseId: 'tool-a',
    });

    const iterator = manager.getMessageIterator(sessionDbId);
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?._persistentId).toBeGreaterThan(0);

    await manager.queueObservation(sessionDbId, {
      tool_name: 'SecondTool',
      tool_input: { step: 2 },
      tool_response: { ok: true },
      prompt_number: 1,
      toolUseId: 'tool-b',
    });

    expect(await manager.confirmClaimedMessages(sessionDbId)).toBe(1);
    await iterator.return?.();

    const rows = db.prepare(`
      SELECT tool_use_id, status
      FROM pending_messages
      WHERE session_db_id = ?
      ORDER BY id ASC
    `).all(sessionDbId) as Array<{ tool_use_id: string; status: string }>;

    expect(rows).toEqual([{ tool_use_id: 'tool-b', status: 'pending' }]);
    expect(await manager.getTotalQueueDepth()).toBe(1);
  });

  test('retryOrFailClaimedMessages retries until max attempts then dead-letters', async () => {
    const sessionDbId = store.createSDKSession(
      'content-retry-invariant',
      'test-project',
      'Test prompt'
    );
    manager.initializeSession(sessionDbId);

    await manager.queueObservation(sessionDbId, {
      tool_name: 'Read',
      tool_input: { path: 'src/a.ts' },
      tool_response: { ok: true },
      prompt_number: 1,
      toolUseId: 'tool-retry',
    });

    const firstIterator = manager.getMessageIterator(sessionDbId);
    const first = await firstIterator.next();
    expect(first.done).toBe(false);

    const firstResult = await manager.retryOrFailClaimedMessages(
      sessionDbId,
      'empty response',
      3,
      Date.now()
    );
    await firstIterator.return?.();

    expect(firstResult).toEqual({ retried: 1, failed: 0 });

    const retryRow = db.prepare(`
      SELECT status, attempt_count, last_error, status_reason
      FROM pending_messages
      WHERE session_db_id = ?
    `).get(sessionDbId) as {
      status: string;
      attempt_count: number;
      last_error: string;
      status_reason: string;
    };

    expect(retryRow.status).toBe('pending');
    expect(retryRow.attempt_count).toBe(1);
    expect(retryRow.last_error).toBe('empty response');
    expect(retryRow.status_reason).toBe('empty response');

    const secondIterator = manager.getMessageIterator(sessionDbId);
    const second = await secondIterator.next();
    expect(second.done).toBe(false);

    const secondResult = await manager.retryOrFailClaimedMessages(
      sessionDbId,
      'parser failure',
      2,
      Date.now()
    );
    await secondIterator.return?.();

    expect(secondResult).toEqual({ retried: 0, failed: 1 });
    expect(await manager.getTotalQueueDepth()).toBe(0);

    const deadLetter = db.prepare(`
      SELECT status_reason, last_error, attempt_count
      FROM pending_message_dead_letters
      WHERE session_db_id = ?
    `).get(sessionDbId) as {
      status_reason: string;
      last_error: string;
      attempt_count: number;
    };

    expect(deadLetter.status_reason).toBe('parser failure');
    expect(deadLetter.last_error).toBe('parser failure');
    expect(deadLetter.attempt_count).toBe(1);
  });

  test('confirmClaimedMessageIds confirms only current split ids and preserves lookahead claims', async () => {
    const sessionDbId = store.createSDKSession(
      'content-scoped-confirm',
      'test-project',
      'Test prompt'
    );
    const session = manager.initializeSession(sessionDbId);

    await manager.queueObservation(sessionDbId, {
      tool_name: 'Read',
      tool_input: { path: 'src/current.ts' },
      tool_response: { ok: true },
      prompt_number: 1,
      toolUseId: 'current-split',
    });
    await manager.queueObservation(sessionDbId, {
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { ok: true },
      prompt_number: 1,
      toolUseId: 'lookahead',
    });

    const iterator = manager.getMessageIterator(sessionDbId);
    const current = await iterator.next();
    const lookahead = await iterator.next();
    expect(current.done).toBe(false);
    expect(lookahead.done).toBe(false);
    expect(session.claimedMessageIds).toEqual([
      current.value!._persistentId,
      lookahead.value!._persistentId,
    ]);

    expect(await manager.confirmClaimedMessageIds(sessionDbId, [current.value!._persistentId])).toBe(1);
    await iterator.return?.();

    const rows = db.prepare(`
      SELECT tool_use_id, status
      FROM pending_messages
      WHERE session_db_id = ?
      ORDER BY id ASC
    `).all(sessionDbId) as Array<{ tool_use_id: string; status: string }>;

    expect(rows).toEqual([{ tool_use_id: 'lookahead', status: 'processing' }]);
    expect(session.claimedMessageIds).toEqual([lookahead.value!._persistentId]);
    expect(session.claimedMessageAttempts).toEqual({
      [lookahead.value!._persistentId]: 0,
    });
    expect(session.earliestPendingTimestamp).toBe(lookahead.value!._originalTimestamp);
  });

  test('retryOrFailClaimedMessageIds retries only current split ids and preserves lookahead claims', async () => {
    const sessionDbId = store.createSDKSession(
      'content-scoped-retry',
      'test-project',
      'Test prompt'
    );
    const session = manager.initializeSession(sessionDbId);

    await manager.queueObservation(sessionDbId, {
      tool_name: 'Read',
      tool_input: { path: 'src/current.ts' },
      tool_response: { ok: true },
      prompt_number: 1,
      toolUseId: 'current-split',
    });
    await manager.queueObservation(sessionDbId, {
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { ok: true },
      prompt_number: 1,
      toolUseId: 'lookahead',
    });

    const iterator = manager.getMessageIterator(sessionDbId);
    const current = await iterator.next();
    const lookahead = await iterator.next();
    expect(current.done).toBe(false);
    expect(lookahead.done).toBe(false);

    const retryAt = Date.now() + 1000;
    expect(await manager.retryOrFailClaimedMessageIds(
      sessionDbId,
      [current.value!._persistentId],
      'invalid split part',
      3,
      retryAt
    )).toEqual({ retried: 1, failed: 0 });
    await iterator.return?.();

    const rows = db.prepare(`
      SELECT tool_use_id, status, attempt_count, last_error, available_at_epoch_ms
      FROM pending_messages
      WHERE session_db_id = ?
      ORDER BY id ASC
    `).all(sessionDbId) as Array<{
      tool_use_id: string;
      status: string;
      attempt_count: number;
      last_error: string | null;
      available_at_epoch_ms: number | null;
    }>;

    expect(rows).toEqual([
      {
        tool_use_id: 'current-split',
        status: 'pending',
        attempt_count: 1,
        last_error: 'invalid split part',
        available_at_epoch_ms: retryAt,
      },
      {
        tool_use_id: 'lookahead',
        status: 'processing',
        attempt_count: 0,
        last_error: null,
        available_at_epoch_ms: null,
      },
    ]);
    expect(session.claimedMessageIds).toEqual([lookahead.value!._persistentId]);
    expect(session.claimedMessageAttempts).toEqual({
      [lookahead.value!._persistentId]: 0,
    });
  });

  test('initializeQueueEngine does not require the database before sqlite mode is used', async () => {
    const previous = process.env.CLAUDE_MEM_QUEUE_ENGINE;
    process.env.CLAUDE_MEM_QUEUE_ENGINE = 'sqlite';
    try {
      const earlyManager = new SessionManager({
        getSessionStore: () => {
          throw new Error('Database not initialized');
        },
      } as unknown as DatabaseManager);

      await expect(earlyManager.initializeQueueEngine()).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_MEM_QUEUE_ENGINE;
      } else {
        process.env.CLAUDE_MEM_QUEUE_ENGINE = previous;
      }
    }
  });
});
