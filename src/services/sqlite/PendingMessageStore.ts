import { Database } from 'bun:sqlite';
import type { PendingMessage } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

export interface PersistentPendingMessage {
  id: number;
  session_db_id: number;
  content_session_id: string;
  message_type: 'observation' | 'summarize';
  tool_name: string | null;
  tool_input: string | null;
  tool_response: string | null;
  cwd: string | null;
  last_assistant_message: string | null;
  prompt_number: number | null;
  status: 'pending' | 'processing';
  created_at_epoch: number;
  agent_type: string | null;
  agent_id: string | null;
  attempt_count: number;
  last_error: string | null;
  available_at_epoch_ms: number | null;
  status_reason: string | null;
  priority: number;
  size_chars: number;
}

export interface QueueSessionStats {
  sessionDbId: number;
  pending: number;
  processing: number;
  delayed: number;
  failed: number;
  oldestPendingAgeMs: number;
  maxAttemptCount: number;
}

export interface QueueStats {
  totalPending: number;
  totalProcessing: number;
  totalDelayed: number;
  totalFailed: number;
  oldestPendingAgeMs: number;
  maxAttemptCount: number;
  sessions: QueueSessionStats[];
}

export class PendingMessageStore {
  private db: Database;

  constructor(
    db: Database,
    private onMutate?: () => void
  ) {
    this.db = db;
  }

  enqueue(sessionDbId: number, contentSessionId: string, message: PendingMessage): number {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO pending_messages (
        session_db_id, content_session_id, tool_use_id, message_type,
        tool_name, tool_input, tool_response, cwd,
        last_assistant_message,
        prompt_number, status, created_at_epoch,
        agent_type, agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `);

    const result = stmt.run(
      sessionDbId,
      contentSessionId,
      message.toolUseId ?? null,
      message.type,
      message.tool_name || null,
      message.tool_input ? JSON.stringify(message.tool_input) : null,
      message.tool_response ? JSON.stringify(message.tool_response) : null,
      message.cwd || null,
      message.last_assistant_message || null,
      message.prompt_number || null,
      now,
      message.agentType ?? null,
      message.agentId ?? null
    );

    if (result.changes > 0) {
      this.onMutate?.();
      return result.lastInsertRowid as number;
    }
    return 0;
  }

  claimNextMessage(sessionDbId: number): PersistentPendingMessage | null {
    const now = Date.now();
    const sql = `
      UPDATE pending_messages
         SET status = 'processing'
       WHERE id = (
         SELECT id FROM pending_messages
          WHERE session_db_id = ?
            AND status = 'pending'
            AND (available_at_epoch_ms IS NULL OR available_at_epoch_ms <= ?)
          ORDER BY priority DESC, id ASC
          LIMIT 1
       )
       RETURNING *
    `;
    const claimed = this.db.prepare(sql).get(sessionDbId, now) as PersistentPendingMessage | null;
    if (claimed) {
      logger.info('QUEUE', `CLAIMED | sessionDbId=${sessionDbId} | messageId=${claimed.id} | type=${claimed.message_type}`, {
        sessionId: sessionDbId
      });
    }
    if (claimed) {
      this.onMutate?.();
    }
    return claimed;
  }

  clearPendingForSession(sessionDbId: number): number {
    const stmt = this.db.prepare(`
      DELETE FROM pending_messages WHERE session_db_id = ?
    `);
    const changes = stmt.run(sessionDbId).changes;
    if (changes > 0) {
      logger.info('QUEUE', `CLEARED | sessionDbId=${sessionDbId} | rowsDeleted=${changes}`, {
        sessionId: sessionDbId
      });
      this.onMutate?.();
    }
    return changes;
  }

  resetProcessingToPending(sessionDbId: number): number {
    const stmt = this.db.prepare(`
      UPDATE pending_messages
         SET status = 'pending'
       WHERE session_db_id = ? AND status = 'processing'
    `);
    const changes = stmt.run(sessionDbId).changes;
    if (changes > 0) {
      logger.info('QUEUE', `RESET_PROCESSING | sessionDbId=${sessionDbId} | rowsReset=${changes}`, {
        sessionId: sessionDbId
      });
      this.onMutate?.();
    }
    return changes;
  }

  getPendingCount(sessionDbId: number): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
    `);
    const result = stmt.get(sessionDbId) as { count: number };
    return result.count;
  }

  getTotalQueueDepth(): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE status IN ('pending', 'processing')
    `);
    const result = stmt.get() as { count: number };
    return result.count;
  }

  hasAnyPendingWork(): boolean {
    return this.getTotalQueueDepth() > 0;
  }

  getSessionsWithPendingMessages(): number[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT session_db_id FROM pending_messages
      WHERE status IN ('pending', 'processing')
      ORDER BY session_db_id ASC
    `);
    return (stmt.all() as Array<{ session_db_id: number }>).map(row => row.session_db_id);
  }

  confirmProcessed(messageId: number): number {
    const stmt = this.db.prepare(`
      DELETE FROM pending_messages
      WHERE id = ? AND status = 'processing'
    `);
    const changes = stmt.run(messageId).changes;
    if (changes > 0) {
      this.onMutate?.();
    }
    return changes;
  }

  confirmProcessedBatch(messageIds: number[]): number {
    let confirmed = 0;
    for (const messageId of uniqueIds(messageIds)) {
      confirmed += this.confirmProcessed(messageId);
    }
    return confirmed;
  }

  getSessionIdsForMessageIds(messageIds: number[]): number[] {
    const ids = uniqueIds(messageIds);
    if (ids.length === 0) return [];

    const stmt = this.db.prepare(`
      SELECT DISTINCT session_db_id
      FROM pending_messages
      WHERE id = ?
    `);
    const sessionIds = new Set<number>();
    for (const messageId of ids) {
      const row = stmt.get(messageId) as { session_db_id: number } | null;
      if (row) {
        sessionIds.add(row.session_db_id);
      }
    }
    return Array.from(sessionIds);
  }

  getNextDelayedAvailableAtEpochMs(sessionDbId: number): number | null {
    const row = this.db.prepare(`
      SELECT MIN(available_at_epoch_ms) AS available_at_epoch_ms
      FROM pending_messages
      WHERE session_db_id = ?
        AND status = 'pending'
        AND available_at_epoch_ms IS NOT NULL
        AND available_at_epoch_ms > ?
    `).get(sessionDbId, Date.now()) as { available_at_epoch_ms: number | null } | null;
    return row?.available_at_epoch_ms ?? null;
  }

  scheduleRetry(messageIds: number[], reason: string, availableAtEpochMs: number): number {
    const ids = uniqueIds(messageIds);
    if (ids.length === 0) return 0;

    const stmt = this.db.prepare(`
      UPDATE pending_messages
         SET status = 'pending',
             attempt_count = attempt_count + 1,
             last_error = ?,
             status_reason = ?,
             available_at_epoch_ms = ?
       WHERE id = ? AND status = 'processing'
    `);

    let changes = 0;
    this.db.transaction(() => {
      for (const messageId of ids) {
        changes += stmt.run(reason, reason, availableAtEpochMs, messageId).changes;
      }
    })();

    if (changes > 0) {
      this.onMutate?.();
    }
    return changes;
  }

  moveToDeadLetter(messageIds: number[], reason: string, error?: string): number {
    const ids = uniqueIds(messageIds);
    if (ids.length === 0) return 0;

    const selectStmt = this.db.prepare(`
      SELECT *
      FROM pending_messages
      WHERE id = ? AND status = 'processing'
    `);
    const insertStmt = this.db.prepare(`
      INSERT INTO pending_message_dead_letters (
        original_message_id,
        session_db_id,
        content_session_id,
        message_type,
        tool_name,
        source_payload,
        attempt_count,
        status_reason,
        last_error,
        failed_at_epoch_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const deleteStmt = this.db.prepare(`
      DELETE FROM pending_messages
      WHERE id = ? AND status = 'processing'
    `);

    const failedAt = Date.now();
    let moved = 0;
    this.db.transaction(() => {
      for (const messageId of ids) {
        const row = selectStmt.get(messageId) as PersistentPendingMessage | null;
        if (!row) continue;
        insertStmt.run(
          row.id,
          row.session_db_id,
          row.content_session_id,
          row.message_type,
          row.tool_name,
          JSON.stringify({
            tool_input: row.tool_input,
            tool_response: row.tool_response,
            cwd: row.cwd,
            last_assistant_message: row.last_assistant_message,
            prompt_number: row.prompt_number,
            agent_type: row.agent_type,
            agent_id: row.agent_id,
          }),
          row.attempt_count,
          reason,
          error ?? row.last_error,
          failedAt
        );
        moved += deleteStmt.run(row.id).changes;
      }
    })();

    if (moved > 0) {
      this.onMutate?.();
    }
    return moved;
  }

  getQueueStats(sessionDbId?: number): QueueStats {
    const now = Date.now();
    const activeRows = this.db.prepare(`
      SELECT
        session_db_id,
        status,
        available_at_epoch_ms,
        created_at_epoch,
        attempt_count
      FROM pending_messages
      ${sessionDbId === undefined ? '' : 'WHERE session_db_id = ?'}
    `).all(...(sessionDbId === undefined ? [] : [sessionDbId])) as Array<{
      session_db_id: number;
      status: 'pending' | 'processing';
      available_at_epoch_ms: number | null;
      created_at_epoch: number;
      attempt_count: number;
    }>;

    const failedRows = this.db.prepare(`
      SELECT session_db_id, COUNT(*) AS count
      FROM pending_message_dead_letters
      ${sessionDbId === undefined ? '' : 'WHERE session_db_id = ?'}
      GROUP BY session_db_id
    `).all(...(sessionDbId === undefined ? [] : [sessionDbId])) as Array<{
      session_db_id: number;
      count: number;
    }>;

    const bySession = new Map<number, QueueSessionStats>();
    const ensure = (id: number): QueueSessionStats => {
      let stats = bySession.get(id);
      if (!stats) {
        stats = {
          sessionDbId: id,
          pending: 0,
          processing: 0,
          delayed: 0,
          failed: 0,
          oldestPendingAgeMs: 0,
          maxAttemptCount: 0,
        };
        bySession.set(id, stats);
      }
      return stats;
    };

    let oldestCreatedAt: number | null = null;
    let maxAttemptCount = 0;
    for (const row of activeRows) {
      const stats = ensure(row.session_db_id);
      stats.maxAttemptCount = Math.max(stats.maxAttemptCount, row.attempt_count);
      maxAttemptCount = Math.max(maxAttemptCount, row.attempt_count);
      if (row.status === 'processing') {
        stats.processing++;
      } else if (row.available_at_epoch_ms !== null && row.available_at_epoch_ms > now) {
        stats.delayed++;
      } else {
        stats.pending++;
      }
      oldestCreatedAt = oldestCreatedAt === null
        ? row.created_at_epoch
        : Math.min(oldestCreatedAt, row.created_at_epoch);
      stats.oldestPendingAgeMs = Math.max(stats.oldestPendingAgeMs, Math.max(0, now - row.created_at_epoch));
    }

    for (const row of failedRows) {
      ensure(row.session_db_id).failed = row.count;
    }

    const sessions = Array.from(bySession.values()).sort((a, b) => a.sessionDbId - b.sessionDbId);
    return {
      totalPending: sessions.reduce((sum, item) => sum + item.pending, 0),
      totalProcessing: sessions.reduce((sum, item) => sum + item.processing, 0),
      totalDelayed: sessions.reduce((sum, item) => sum + item.delayed, 0),
      totalFailed: sessions.reduce((sum, item) => sum + item.failed, 0),
      oldestPendingAgeMs: oldestCreatedAt === null ? 0 : Math.max(0, now - oldestCreatedAt),
      maxAttemptCount,
      sessions,
    };
  }

  peekPendingTypes(sessionDbId: number): Array<{ message_type: string; tool_name: string | null }> {
    const stmt = this.db.prepare(`
      SELECT message_type, tool_name FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
      ORDER BY id ASC
    `);
    return stmt.all(sessionDbId) as Array<{ message_type: string; tool_name: string | null }>;
  }

  toPendingMessage(persistent: PersistentPendingMessage): PendingMessage {
    return {
      type: persistent.message_type,
      tool_name: persistent.tool_name || undefined,
      tool_input: persistent.tool_input ? JSON.parse(persistent.tool_input) : undefined,
      tool_response: persistent.tool_response ? JSON.parse(persistent.tool_response) : undefined,
      prompt_number: persistent.prompt_number || undefined,
      cwd: persistent.cwd || undefined,
      last_assistant_message: persistent.last_assistant_message || undefined,
      agentId: persistent.agent_id ?? undefined,
      agentType: persistent.agent_type ?? undefined
    };
  }
}

function uniqueIds(ids: number[]): number[] {
  return [...new Set(ids.filter(id => Number.isInteger(id) && id > 0))];
}
