import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { createSDKSession } from '../../../src/services/sqlite/Sessions.js';
import { SqliteObservationQueueEngine } from '../../../src/server/queue/ObservationQueueEngine.js';
import type { Database } from 'bun:sqlite';

describe('ObservationQueueEngine contract', () => {
  let db: Database;
  let engine: SqliteObservationQueueEngine;
  let sessionDbId: number;
  const contentSessionId = 'engine-contract-session';

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    engine = new SqliteObservationQueueEngine(db);
    sessionDbId = createSDKSession(db, contentSessionId, 'test-project', 'Test prompt');
  });

  afterEach(() => {
    engine.close();
    db.close();
  });

  test('deduplicates messages by content session and tool use id', async () => {
    const firstId = await engine.enqueue(sessionDbId, contentSessionId, {
      type: 'observation',
      tool_name: 'Read',
      toolUseId: 'tool-1',
    });
    const duplicateId = await engine.enqueue(sessionDbId, contentSessionId, {
      type: 'observation',
      tool_name: 'Read',
      toolUseId: 'tool-1',
    });

    expect(firstId).toBeGreaterThan(0);
    expect(duplicateId).toBe(0);
    expect(await engine.getPendingCount(sessionDbId)).toBe(1);
  });

  test('iterator yields FIFO messages with provider metadata intact', async () => {
    const firstId = await engine.enqueue(sessionDbId, contentSessionId, {
      type: 'observation',
      tool_name: 'Read',
      tool_input: { file: 'a.ts' },
      agentId: 'agent-1',
      agentType: 'subagent',
    });
    const secondId = await engine.enqueue(sessionDbId, contentSessionId, {
      type: 'summarize',
      last_assistant_message: 'done',
    });

    const abortController = new AbortController();
    const iterator = engine.createIterator({
      sessionDbId,
      signal: abortController.signal,
    });

    const first = await iterator.next();
    const second = await iterator.next();
    abortController.abort();

    expect(first.done).toBe(false);
    expect(second.done).toBe(false);
    expect(first.value).toMatchObject({
      _persistentId: firstId,
      type: 'observation',
      tool_name: 'Read',
      tool_input: { file: 'a.ts' },
      agentId: 'agent-1',
      agentType: 'subagent',
    });
    expect(typeof first.value._originalTimestamp).toBe('number');
    expect(second.value).toMatchObject({
      _persistentId: secondId,
      type: 'summarize',
      last_assistant_message: 'done',
    });
  });

  test('resetProcessingToPending makes claimed rows visible after restart', async () => {
    const messageId = await engine.enqueue(sessionDbId, contentSessionId, {
      type: 'observation',
      tool_name: 'Grep',
    });

    const firstController = new AbortController();
    const firstIterator = engine.createIterator({
      sessionDbId,
      signal: firstController.signal,
    });
    const claimed = await firstIterator.next();
    firstController.abort();

    expect(claimed.value._persistentId).toBe(messageId);
    expect(await engine.resetProcessingToPending(sessionDbId)).toBe(1);

    const secondController = new AbortController();
    const secondIterator = engine.createIterator({
      sessionDbId,
      signal: secondController.signal,
    });
    const reclaimed = await secondIterator.next();
    secondController.abort();

    expect(reclaimed.value._persistentId).toBe(messageId);
  });

  test('iterator exits through idle timeout callback', async () => {
    const abortController = new AbortController();
    let idleTimedOut = false;

    const iterator = engine.createIterator({
      sessionDbId,
      signal: abortController.signal,
      idleTimeoutMs: 10,
      onIdleTimeout: () => {
        idleTimedOut = true;
        abortController.abort();
      },
    });

    const result = await iterator.next();

    expect(result.done).toBe(true);
    expect(idleTimedOut).toBe(true);
  });

  test('getTotalQueueDepth counts pending and processing rows across sessions', async () => {
    const otherSessionDbId = createSDKSession(db, 'engine-contract-other', 'test-project', 'Other prompt');
    await engine.enqueue(sessionDbId, contentSessionId, { type: 'observation', tool_name: 'Read' });
    await engine.enqueue(otherSessionDbId, 'engine-contract-other', { type: 'summarize' });

    const abortController = new AbortController();
    const iterator = engine.createIterator({
      sessionDbId,
      signal: abortController.signal,
    });
    await iterator.next();
    abortController.abort();

    expect(await engine.getPendingCount(sessionDbId)).toBe(1);
    expect(await engine.getPendingCount(otherSessionDbId)).toBe(1);
    expect(await engine.getTotalQueueDepth()).toBe(2);
  });

  test('confirmProcessedBatch deletes exact processing rows', async () => {
    const firstId = await engine.enqueue(sessionDbId, contentSessionId, { type: 'observation', tool_name: 'Read' });
    const secondId = await engine.enqueue(sessionDbId, contentSessionId, { type: 'observation', tool_name: 'Grep' });

    const abortController = new AbortController();
    const iterator = engine.createIterator({
      sessionDbId,
      signal: abortController.signal,
    });
    await iterator.next();
    await iterator.next();
    abortController.abort();

    expect(await engine.confirmProcessedBatch([firstId, secondId])).toBe(2);
    expect(await engine.getPendingCount(sessionDbId)).toBe(0);
  });

  test('scheduleRetry delays claimed rows and exposes queue stats', async () => {
    const messageId = await engine.enqueue(sessionDbId, contentSessionId, { type: 'observation', tool_name: 'Read' });

    const firstController = new AbortController();
    const firstIterator = engine.createIterator({
      sessionDbId,
      signal: firstController.signal,
    });
    await firstIterator.next();
    firstController.abort();

    const availableAt = Date.now() + 60_000;
    expect(await engine.scheduleRetry([messageId], 'provider_timeout', availableAt)).toBe(1);

    const stats = await engine.getQueueStats(sessionDbId);
    expect(stats.totalPending).toBe(0);
    expect(stats.totalDelayed).toBe(1);
    expect(stats.totalProcessing).toBe(0);
    expect(stats.sessions[0]).toMatchObject({
      sessionDbId,
      delayed: 1,
      maxAttemptCount: 1,
    });

    const secondController = new AbortController();
    const secondIterator = engine.createIterator({
      sessionDbId,
      signal: secondController.signal,
      idleTimeoutMs: 10,
    });
    const delayedResult = await secondIterator.next();
    secondController.abort();

    expect(delayedResult.done).toBe(true);
  });

  test('scheduleRetry wakes iterator when delayed retry becomes available without another enqueue', async () => {
    const messageId = await engine.enqueue(sessionDbId, contentSessionId, {
      type: 'observation',
      tool_name: 'Read',
      toolUseId: 'retry-wake',
    });

    const firstController = new AbortController();
    const firstIterator = engine.createIterator({
      sessionDbId,
      signal: firstController.signal,
    });
    const first = await firstIterator.next();
    firstController.abort();
    await firstIterator.return?.();
    expect(first.value._persistentId).toBe(messageId);

    const availableAt = Date.now() + 50;
    expect(await engine.scheduleRetry([messageId], 'provider_timeout', availableAt)).toBe(1);

    const secondController = new AbortController();
    const secondIterator = engine.createIterator({
      sessionDbId,
      signal: secondController.signal,
      idleTimeoutMs: 500,
    });

    let yieldedEarly = false;
    const nextResult = secondIterator.next().then(result => {
      yieldedEarly = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(yieldedEarly).toBe(false);

    const retried = await nextResult;
    secondController.abort();
    await secondIterator.return?.();

    expect(retried.done).toBe(false);
    expect(retried.value._persistentId).toBe(messageId);
    expect(retried.value.attemptCount).toBe(1);
    expect(retried.value.availableAtEpochMs).toBe(availableAt);
  });

  test('scheduleRetry wakes each delayed retry in a session when delays differ', async () => {
    const firstId = await engine.enqueue(sessionDbId, contentSessionId, {
      type: 'observation',
      tool_name: 'Read',
      toolUseId: 'retry-wake-first',
    });
    const secondId = await engine.enqueue(sessionDbId, contentSessionId, {
      type: 'observation',
      tool_name: 'Grep',
      toolUseId: 'retry-wake-second',
    });

    const firstController = new AbortController();
    const firstIterator = engine.createIterator({
      sessionDbId,
      signal: firstController.signal,
    });
    const firstClaim = await firstIterator.next();
    const secondClaim = await firstIterator.next();
    firstController.abort();
    await firstIterator.return?.();
    expect(firstClaim.value._persistentId).toBe(firstId);
    expect(secondClaim.value._persistentId).toBe(secondId);

    const firstAvailableAt = Date.now() + 40;
    const secondAvailableAt = Date.now() + 90;
    expect(await engine.scheduleRetry([firstId], 'provider_timeout', firstAvailableAt)).toBe(1);
    expect(await engine.scheduleRetry([secondId], 'provider_timeout', secondAvailableAt)).toBe(1);

    const secondController = new AbortController();
    const secondIterator = engine.createIterator({
      sessionDbId,
      signal: secondController.signal,
      idleTimeoutMs: 500,
    });

    const firstRetried = await secondIterator.next();
    expect(firstRetried.done).toBe(false);
    expect(firstRetried.value._persistentId).toBe(firstId);

    let yieldedSecondEarly = false;
    const secondRetryPromise = secondIterator.next().then(result => {
      yieldedSecondEarly = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(yieldedSecondEarly).toBe(false);

    const secondRetried = await secondRetryPromise;
    secondController.abort();
    await secondIterator.return?.();

    expect(secondRetried.done).toBe(false);
    expect(secondRetried.value._persistentId).toBe(secondId);
    expect(secondRetried.value.availableAtEpochMs).toBe(secondAvailableAt);
  });

  test('moveMessagesToDeadLetter removes claimed rows and counts failures', async () => {
    const messageId = await engine.enqueue(sessionDbId, contentSessionId, { type: 'observation', tool_name: 'Read' });

    const abortController = new AbortController();
    const iterator = engine.createIterator({
      sessionDbId,
      signal: abortController.signal,
    });
    await iterator.next();
    abortController.abort();

    expect(await engine.moveMessagesToDeadLetter([messageId], 'max_attempts', 'empty response')).toBe(1);
    expect(await engine.getPendingCount(sessionDbId)).toBe(0);

    const stats = await engine.getQueueStats(sessionDbId);
    expect(stats.totalFailed).toBe(1);
    expect(stats.sessions[0]).toMatchObject({
      sessionDbId,
      failed: 1,
    });
  });
});
