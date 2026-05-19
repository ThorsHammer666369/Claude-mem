# Local LLM Queue Backpressure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a worker-side LLM drain layer so slow local providers are paced, retry-bounded, observable, and safe under queue pressure without slowing hook ingestion or touching user memory data.

**Architecture:** Keep the persistent queue as the durable FIFO ingestion layer. Add a `SmartLlmDrain` above `SessionManager.getMessageIterator()` and below provider prompt construction, then teach provider loops to consume drain items and confirm or fail the source queue IDs through explicit queue operations. Use additive metadata and a dead-letter table for failed/skipped queue items so the existing `pending_messages` status check does not need a risky table rebuild.

**Tech Stack:** TypeScript, Bun test, Express worker routes, SQLite via `bun:sqlite`, existing provider classes (`ClaudeProvider`, `GeminiProvider`, `OpenRouterProvider`).

---

## Current Flow Verified On 2026-05-15

The brief mentions `src/services/worker/SDKAgent.ts`, but this checkout does not have that file. The active equivalents are:

- `src/services/worker/ClaudeProvider.ts`
- `src/services/worker/GeminiProvider.ts`
- `src/services/worker/OpenRouterProvider.ts`
- `src/services/worker/agents/ResponseProcessor.ts`

Current queue flow:

```text
worker HTTP route
  -> ingestObservation(...)
  -> SessionManager.queueObservation(...)
  -> PendingMessageStore.enqueue(...)
  -> pending_messages row inserted
  -> SessionManager.getMessageIterator(...)
  -> ObservationQueueEngine.createIterator(...)
  -> SessionQueueProcessor.createIterator(...)
  -> PendingMessageStore.claimNextMessage(...)
  -> provider loop builds one prompt immediately
  -> provider query/fetch call
  -> processAgentResponse(...)
  -> SessionManager.confirmClaimedMessages(...) or resetProcessingToPending(...)
```

Important current constraints:

- `pending_messages.status` only allows `pending` and `processing`.
- `SessionManager.confirmClaimedMessages()` confirms every ID in `session.claimedMessageIds`.
- `processAgentResponse()` currently confirms invalid parser output instead of retrying forever.
- Direct providers (`GeminiProvider`, `OpenRouterProvider`) already do one provider request per claimed queue row.
- Claude SDK uses an async prompt generator, so pacing must occur before yielding user messages into `query({ prompt: messageGenerator })`.
- Settings defaults live in `src/shared/SettingsDefaultsManager.ts`.
- `/api/health` lives in `src/services/server/Server.ts`; route modules are registered from `src/services/worker-service.ts`.

## File Plan

Create:

- `src/services/worker/llm/SmartLlmDrain.ts`
  Owns queue drain options, source ID preservation, priority classification, batching/coalescing decisions, send pacing, adaptive backoff state, and drain metrics.

- `src/services/worker/llm/SmartLlmDrainSettings.ts`
  Parses `SettingsDefaultsManager` output into typed drain options with clamp/default behavior.

- `src/services/worker/llm/SmartLlmPromptBuilder.ts`
  Builds parser-compatible single, batch, and coalesced prompt strings from drain items using existing prompt builders.

- `tests/services/worker/llm/SmartLlmDrain.test.ts`
  Unit coverage for off/local_safe pacing, batching, high-priority protection, source ID preservation, backoff, and metrics.

- `tests/services/worker/llm/SmartLlmPromptBuilder.test.ts`
  Verifies batch/coalesced prompts include source IDs and keep summarize messages out of observation batches.

- `tests/services/worker/llm/SmartLlmDrain.integration.test.ts`
  Fake slow-provider test that enqueues a burst and verifies gradual drain, hard retry limits, and preservation of high-value rows.

- `docs/public/configuration/local-llm-queue-backpressure.mdx`
  Documents local-safe settings and mitigation profile.

Modify:

- `src/shared/SettingsDefaultsManager.ts`
  Add queue drain settings to the interface and defaults.

- `tests/shared/settings-defaults-manager.test.ts`
  Verify new settings are written, merged, and env-overridable.

- `src/services/worker-types.ts`
  Extend `PendingMessageWithId` with optional queue metadata fields.

- `src/services/sqlite/schema.sql`
  Add new queue metadata columns for fresh databases and a dead-letter table.

- `src/services/sqlite/migrations/runner.ts`
  Add a new migration after current tip 34 for queue metadata and the dead-letter table.

- `src/services/sqlite/SessionStore.ts`
  Mirror the migration because worker-bundled code uses `SessionStore` directly in prior fixes.

- `src/services/sqlite/PendingMessageStore.ts`
  Add metadata-aware claim, explicit batch confirmation, retry scheduling, dead-letter insertion, and queue stats methods.

- `src/server/queue/ObservationQueueEngine.ts`
  Extend queue interfaces with methods actually used by the drain.

- `src/server/queue/BullMqObservationQueueEngine.ts`
  Add compatible method stubs or BullMQ-backed implementations so interface changes do not break Redis mode.

- `src/services/queue/SessionQueueProcessor.ts`
  Keep it as the low-level iterator; only adjust claim to respect `available_at_epoch_ms` and metadata.

- `src/services/worker/SessionManager.ts`
  Add explicit source-ID confirmation/failure APIs and queue stats access without changing enqueue behavior.

- `src/services/worker/ClaudeProvider.ts`
  Wrap `sessionManager.getMessageIterator()` with `SmartLlmDrain`, pace before yielding SDK user messages, and report provider/parser health to the drain.

- `src/services/worker/GeminiProvider.ts`
  Consume drain items in `processMessageLoop()`, build one provider prompt per drain item, and call explicit confirmation/failure APIs.

- `src/services/worker/OpenRouterProvider.ts`
  Same as Gemini provider.

- `src/services/worker/agents/ResponseProcessor.ts`
  Accept an optional source-ID confirmation context so provider code can confirm exactly the IDs represented by a drain item instead of every session-level claimed ID.

- `src/services/server/Server.ts` or a new `src/services/worker/http/routes/QueueRoutes.ts`
  Expose `GET /api/queue/status`; prefer a dedicated route if the response grows beyond `/api/health`.

- `src/services/worker-service.ts`
  Register queue status route or pass queue drain metrics into server health options.

- `docs/production-guide.md`
  Update queue health guidance for local LLM users and the new metrics endpoint.

- `PROJECT-REBOOT.md`
  Keep the branch, plan, safety constraints, and next action visible for a new thread.

## Implementation Tasks

### Task 1: Add Typed Settings Defaults

**Files:**
- Modify: `src/shared/SettingsDefaultsManager.ts`
- Modify: `tests/shared/settings-defaults-manager.test.ts`

- [ ] Add these keys to `SettingsDefaults`:

```ts
CLAUDE_MEM_LLM_QUEUE_MODE: string;
CLAUDE_MEM_LLM_MIN_SEND_INTERVAL_MS: string;
CLAUDE_MEM_LLM_BATCH_MAX_ITEMS: string;
CLAUDE_MEM_LLM_BATCH_MAX_CHARS: string;
CLAUDE_MEM_LLM_COALESCE_WINDOW_MS: string;
CLAUDE_MEM_LLM_ADAPTIVE_BACKOFF: string;
CLAUDE_MEM_LLM_MAX_ATTEMPTS: string;
CLAUDE_MEM_QUEUE_HIGH_WATERMARK: string;
CLAUDE_MEM_QUEUE_CRITICAL_WATERMARK: string;
CLAUDE_MEM_QUEUE_DROP_POLICY: string;
CLAUDE_MEM_QUEUE_METRICS_ENABLED: string;
```

- [ ] Add defaults that preserve existing cloud-provider behavior:

```ts
CLAUDE_MEM_LLM_QUEUE_MODE: 'auto',
CLAUDE_MEM_LLM_MIN_SEND_INTERVAL_MS: '0',
CLAUDE_MEM_LLM_BATCH_MAX_ITEMS: '3',
CLAUDE_MEM_LLM_BATCH_MAX_CHARS: '24000',
CLAUDE_MEM_LLM_COALESCE_WINDOW_MS: '5000',
CLAUDE_MEM_LLM_ADAPTIVE_BACKOFF: 'true',
CLAUDE_MEM_LLM_MAX_ATTEMPTS: '3',
CLAUDE_MEM_QUEUE_HIGH_WATERMARK: '200',
CLAUDE_MEM_QUEUE_CRITICAL_WATERMARK: '1000',
CLAUDE_MEM_QUEUE_DROP_POLICY: 'coalesce_low_value',
CLAUDE_MEM_QUEUE_METRICS_ENABLED: 'true',
```

- [ ] Add test assertions:

```ts
expect(defaults.CLAUDE_MEM_LLM_QUEUE_MODE).toBe('auto');
expect(defaults.CLAUDE_MEM_LLM_MIN_SEND_INTERVAL_MS).toBe('0');
expect(defaults.CLAUDE_MEM_LLM_MAX_ATTEMPTS).toBe('3');
expect(defaults.CLAUDE_MEM_QUEUE_METRICS_ENABLED).toBe('true');
```

- [ ] Run:

```powershell
bun test tests/shared/settings-defaults-manager.test.ts
```

Expected: settings defaults test file passes.

### Task 2: Add Queue Metadata And Dead-Letter Storage

**Files:**
- Modify: `src/services/sqlite/schema.sql`
- Modify: `src/services/sqlite/migrations/runner.ts`
- Modify: `src/services/sqlite/SessionStore.ts`
- Modify: `tests/services/sqlite/migration-runner.test.ts`
- Modify: `tests/services/sqlite/PendingMessageStore.test.ts`

- [ ] Add metadata columns without deleting/resetting rows:

```sql
ALTER TABLE pending_messages ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pending_messages ADD COLUMN last_error TEXT;
ALTER TABLE pending_messages ADD COLUMN available_at_epoch_ms INTEGER;
ALTER TABLE pending_messages ADD COLUMN status_reason TEXT;
ALTER TABLE pending_messages ADD COLUMN priority INTEGER NOT NULL DEFAULT 50;
ALTER TABLE pending_messages ADD COLUMN size_chars INTEGER NOT NULL DEFAULT 0;
```

- [ ] Add a dead-letter table instead of changing the existing `status` CHECK:

```sql
CREATE TABLE IF NOT EXISTS pending_message_dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_message_id INTEGER NOT NULL,
  session_db_id INTEGER NOT NULL,
  content_session_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  tool_name TEXT,
  source_payload TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  status_reason TEXT NOT NULL,
  last_error TEXT,
  failed_at_epoch_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_dead_letters_session
  ON pending_message_dead_letters(session_db_id);
CREATE INDEX IF NOT EXISTS idx_pending_dead_letters_failed
  ON pending_message_dead_letters(failed_at_epoch_ms DESC);
```

- [ ] Update fresh schema comments to state that failed/skipped rows are persisted in `pending_message_dead_letters` and removed from active queue only after dead-letter insert succeeds.

- [ ] Mirror the migration in `SessionStore.ts` using direct `PRAGMA table_info(pending_messages)` checks, matching the existing mirror pattern.

- [ ] Run:

```powershell
bun test tests/services/sqlite/migration-runner.test.ts tests/services/sqlite/PendingMessageStore.test.ts
```

Expected: migration and pending-message tests pass.

### Task 3: Add Queue Store Operations

**Files:**
- Modify: `src/services/sqlite/PendingMessageStore.ts`
- Modify: `src/server/queue/ObservationQueueEngine.ts`
- Modify: `src/server/queue/BullMqObservationQueueEngine.ts`
- Modify: `tests/services/queue/ObservationQueueEngine.contract.test.ts`
- Modify: `tests/services/queue/bullmq-observation-queue-engine.test.ts`

- [ ] Extend `PersistentPendingMessage` with:

```ts
attempt_count: number;
last_error: string | null;
available_at_epoch_ms: number | null;
status_reason: string | null;
priority: number;
size_chars: number;
```

- [ ] Change `claimNextMessage()` to skip delayed rows:

```sql
WHERE session_db_id = ?
  AND status = 'pending'
  AND (available_at_epoch_ms IS NULL OR available_at_epoch_ms <= ?)
ORDER BY priority DESC, id ASC
LIMIT 1
```

- [ ] Add `confirmProcessedBatch(messageIds: number[]): number`.

- [ ] Add `scheduleRetry(messageIds: number[], reason: string, availableAtEpochMs: number): number` that increments `attempt_count`, stores `last_error`, writes `status_reason`, and returns rows to `pending`.

- [ ] Add `moveToDeadLetter(messageIds: number[], reason: string, error?: string): number` that inserts into `pending_message_dead_letters` inside a transaction and deletes only the copied `processing` rows.

- [ ] Add `getQueueStats(sessionDbId?: number)` returning pending, processing, delayed, failed/dead-letter, oldest age, and max attempt counts.

- [ ] Run:

```powershell
bun test tests/services/queue/ObservationQueueEngine.contract.test.ts tests/services/queue/bullmq-observation-queue-engine.test.ts
```

Expected: both queue engines satisfy the expanded contract.

### Task 4: Build `SmartLlmDrain`

**Files:**
- Create: `src/services/worker/llm/SmartLlmDrain.ts`
- Create: `src/services/worker/llm/SmartLlmDrainSettings.ts`
- Modify: `src/services/worker-types.ts`
- Create: `tests/services/worker/llm/SmartLlmDrain.test.ts`

- [ ] Define drain item types:

```ts
export type DrainItem =
  | { kind: 'single'; message: PendingMessageWithId; sourceIds: number[]; priority: number }
  | { kind: 'batch'; messages: PendingMessageWithId[]; sourceIds: number[]; syntheticTitle: string; syntheticBody: string; priority: number }
  | { kind: 'coalesced'; messages: PendingMessageWithId[]; sourceIds: number[]; syntheticTitle: string; syntheticBody: string; priority: number };
```

- [ ] Implement classification rules:

```ts
summarize -> 100
observation with tool error/failure text -> 80
observation with Write/Edit/MultiEdit/Delete/package/config/migration signals -> 70
observation with Bash output -> 50
observation with Read -> 40
observation with Grep/Glob/LS/ListMcpResourcesTool -> 30
duplicate low-value observation -> 20
```

- [ ] Implement mode behavior:

```text
off: yield one single item with no pacing and no batching
auto: keep min interval 0 by default unless queue pressure is high
local_safe: enforce minSendIntervalMs before every drain item
```

- [ ] Implement batching only for compatible priority 30-50 observations from the same session and project.

- [ ] Implement coalescing for repeated `Read`, `Grep`, `Glob`, `LS`, and `ListMcpResourcesTool` rows when total queue pressure is at or above high watermark.

- [ ] Preserve all `_persistentId` values in every drain item.

- [ ] Track provider health:

```ts
recordProviderSuccess(latencyMs: number): void;
recordProviderTimeout(reason: string): void;
recordProviderEmptyResponse(reason: string): void;
recordParserFailure(reason: string): void;
getMetrics(): SmartLlmDrainMetrics;
```

- [ ] Add tests for the 15 cases from the brief, with fake timers or a small injectable sleep function so tests do not wait 1500ms in real time.

- [ ] Run:

```powershell
bun test tests/services/worker/llm/SmartLlmDrain.test.ts
```

Expected: drain unit tests pass.

### Task 5: Build Drain Prompt Construction

**Files:**
- Create: `src/services/worker/llm/SmartLlmPromptBuilder.ts`
- Create: `tests/services/worker/llm/SmartLlmPromptBuilder.test.ts`

- [ ] For `single` observation items, call existing `buildObservationPrompt(...)`.

- [ ] For `single` summarize items, call existing `buildSummaryPrompt(...)`.

- [ ] For `batch` items, build a parser-compatible observation prompt whose tool output starts with:

```text
This is a batch of N queued observations from one session.
Create separate structured observations for each numbered source item.
Do not merge unrelated failures.
Return valid parser-compatible output.
Preserve source pending message IDs in metadata or facts.
```

- [ ] Include each source ID in the batch body:

```text
Source pending message ID: <id>
Tool: <tool_name>
CWD: <cwd or unknown>
Input JSON: <redacted/truncated JSON>
Output JSON: <redacted/truncated JSON>
```

- [ ] Redact likely secret fields before logging or synthetic prompt metadata:

```ts
authorization, cookie, token, api_key, password, secret, bearer
```

- [ ] Run:

```powershell
bun test tests/services/worker/llm/SmartLlmPromptBuilder.test.ts
```

Expected: source IDs appear, secret-like fields are redacted, summaries are never batched.

### Task 6: Change Confirmation From Session-Wide To Source-ID Exact

**Files:**
- Modify: `src/services/worker/SessionManager.ts`
- Modify: `src/services/worker/agents/ResponseProcessor.ts`
- Modify: `tests/worker/agents/response-processor.test.ts`
- Modify: `tests/services/worker/session-manager-queue.test.ts`

- [ ] Add:

```ts
async confirmMessageIds(sessionDbId: number, sourceIds: number[]): Promise<number>;
async scheduleMessageRetry(sessionDbId: number, sourceIds: number[], reason: string, availableAtEpochMs: number): Promise<number>;
async moveMessagesToDeadLetter(sessionDbId: number, sourceIds: number[], reason: string, error?: string): Promise<number>;
```

- [ ] Keep `confirmClaimedMessages()` as a compatibility wrapper.

- [ ] Add an optional process context:

```ts
interface AgentResponseQueueContext {
  sourceIds?: number[];
  onParserFailure?: (reason: string) => Promise<void>;
  onSuccess?: (sourceIds: number[]) => Promise<void>;
}
```

- [ ] Update `processAgentResponse()` so valid parsed output confirms `queueContext.sourceIds` when provided, and falls back to `confirmClaimedMessages()` only for legacy callers.

- [ ] On parser failure, call `queueContext.onParserFailure('non_xml_or_empty_response')` when provided; otherwise preserve the current behavior of confirming claimed rows to avoid loops.

- [ ] Run:

```powershell
bun test tests/worker/agents/response-processor.test.ts tests/services/worker/session-manager-queue.test.ts
```

Expected: old callers still work, new callers confirm only the source IDs represented by the drain item.

### Task 7: Wire Drain Into Claude SDK Provider

**Files:**
- Modify: `src/services/worker/ClaudeProvider.ts`
- Test: add or update `tests/worker/agents/response-processor.test.ts` or a focused Claude provider test if one exists.

- [ ] Create the drain in `startSession()` after settings/model are known.

- [ ] Replace the raw iterator loop in `createMessageGenerator()` with:

```ts
const rawIterator = this.sessionManager.getMessageIterator(session.sessionDbId);
for await (const drainItem of drain.drain(rawIterator, session.abortController.signal)) {
  const prompt = buildPromptForDrainItem(drainItem, session, mode);
  session.activeDrainSourceIds = drainItem.sourceIds;
  yield { type: 'user', message: { role: 'user', content: prompt }, session_id: session.contentSessionId, parent_tool_use_id: null, isSynthetic: true };
}
```

- [ ] In the assistant response handling path, pass `sourceIds` into `processAgentResponse()`.

- [ ] Record latency from before yielding a prompt to receiving assistant text.

- [ ] On SDK error/timeout/empty response, schedule retry or dead-letter according to `attempt_count` and `CLAUDE_MEM_LLM_MAX_ATTEMPTS`.

- [ ] Run:

```powershell
bun test tests/worker/agents/response-processor.test.ts
```

Expected: source-ID confirmation and parser-failure handling pass without changing hook ingestion.

### Task 8: Wire Drain Into Gemini And OpenRouter Providers

**Files:**
- Modify: `src/services/worker/GeminiProvider.ts`
- Modify: `src/services/worker/OpenRouterProvider.ts`
- Create or update provider loop tests under `tests/worker/`

- [ ] Replace each `for await (const message of this.sessionManager.getMessageIterator(...))` loop with `SmartLlmDrain`.

- [ ] Convert `DrainItem` into a prompt through `SmartLlmPromptBuilder`.

- [ ] Confirm only `drainItem.sourceIds` after `processAgentResponse()` succeeds.

- [ ] On empty content, call drain empty-response handling and schedule retry/dead-letter instead of leaving queue state ambiguous.

- [ ] Run:

```powershell
bun test tests/worker/provider-errors.test.ts tests/worker/provider-classifiers.test.ts
```

Expected: provider classification still passes; new provider drain tests should pass.

### Task 9: Expose Queue Status

**Files:**
- Create: `src/services/worker/http/routes/QueueRoutes.ts`
- Modify: `src/services/worker-service.ts`
- Modify: `src/services/server/Server.ts` only if health needs a small summary field
- Create: `tests/worker/http/routes/queue-routes.test.ts`
- Modify: `tests/integration/worker-api-endpoints.test.ts`

- [ ] Add `GET /api/queue/status` returning:

```json
{
  "totalPending": 0,
  "totalProcessing": 0,
  "totalFailed": 0,
  "oldestPendingAgeMs": 0,
  "sessions": [],
  "provider": {
    "mode": "auto",
    "minSendIntervalMs": 0,
    "currentBackoffMs": 0,
    "lastLatencyMs": 0,
    "emptyResponseCount": 0,
    "parserFailureCount": 0
  },
  "pressure": {
    "highWatermark": 200,
    "criticalWatermark": 1000,
    "dropPolicy": "coalesce_low_value"
  }
}
```

- [ ] Keep secrets out of route output.

- [ ] Run:

```powershell
bun test tests/worker/http/routes/queue-routes.test.ts tests/integration/worker-api-endpoints.test.ts
```

Expected: queue status route returns 200 and does not break `/api/health`.

### Task 10: Add Slow Provider Integration Test

**Files:**
- Create: `tests/services/worker/llm/SmartLlmDrain.integration.test.ts`

- [ ] Enqueue 200 low-value observations quickly into an in-memory SQLite database.

- [ ] Use an injected fake provider function that takes a controlled virtual delay per response.

- [ ] Verify:

```text
queue drains gradually
source IDs are preserved
low-value duplicates coalesce under pressure
summaries are preserved
tool errors/build failures are not coalesced away
empty responses retry up to maxAttempts
after maxAttempts rows move to dead letter
metrics report high/critical pressure
```

- [ ] Run:

```powershell
bun test tests/services/worker/llm/SmartLlmDrain.integration.test.ts
```

Expected: fake slow-provider scenario passes without real network/provider calls.

### Task 11: Update Docs

**Files:**
- Create: `docs/public/configuration/local-llm-queue-backpressure.mdx`
- Modify: `docs/production-guide.md`
- Modify: `docs/public/docs.json` if this doc set requires navigation registration

- [ ] Document the local-safe profile:

```text
CLAUDE_MEM_MAX_CONCURRENT_AGENTS=1
CLAUDE_MEM_LLM_QUEUE_MODE=local_safe
CLAUDE_MEM_LLM_MIN_SEND_INTERVAL_MS=1500
CLAUDE_MEM_LLM_BATCH_MAX_ITEMS=1
CLAUDE_MEM_LLM_BATCH_MAX_CHARS=12000
CLAUDE_MEM_LLM_COALESCE_WINDOW_MS=5000
CLAUDE_MEM_LLM_ADAPTIVE_BACKOFF=true
```

- [ ] State that this does not delete, reset, or migrate user memory content.

- [ ] Add troubleshooting commands for `/api/queue/status` and log patterns.

- [ ] Run:

```powershell
bun test tests/utils/skill-docs-placement.test.ts
```

Expected: docs placement checks pass if applicable.

### Task 12: Full Verification

**Files:**
- No new files.

- [ ] Run focused tests:

```powershell
bun test tests/services/worker/llm/SmartLlmDrain.test.ts tests/services/worker/llm/SmartLlmPromptBuilder.test.ts tests/services/worker/session-manager-queue.test.ts tests/services/sqlite/PendingMessageStore.test.ts tests/services/queue/SessionQueueProcessor.test.ts tests/worker/agents/response-processor.test.ts
```

- [ ] Run build:

```powershell
npm run build
```

- [ ] Run typecheck if feasible:

```powershell
npm run typecheck:root
```

Expected: build passes. If `typecheck:root` still has unrelated pre-existing failures, capture the exact first unrelated errors and do not conflate them with this branch.

## Safety Notes

- Do not delete `~/.claude-mem`, `claude-mem.db`, Chroma data, or installed plugin cache copies while implementing this branch.
- Patch TypeScript source first; only rebuild/generated plugin scripts during explicit validation or packaging.
- Keep hook endpoints and `queueObservation()` fast.
- Do not hard-code user paths, ports, or provider URLs.
- Avoid logging full private prompts, repo URLs with tokens, API keys, auth headers, cookies, bearer tokens, or passwords.
- Prefer queue dead-letter records over infinite `resetProcessingToPending(...)` loops.

## Rollback

```powershell
git switch main
git branch -D codex/local-llm-queue-backpressure
```

For installed local plugin copies, rebuild/reinstall only after source validation:

```powershell
npm run build
npm run sync-marketplace
npx claude-mem repair
```

Do not delete `claude-mem.db` for rollback.

## Gaps To Resolve During Implementation

- Decide whether Claude SDK prompt generator can reliably map one yielded prompt to one assistant response for exact `sourceIds`; if not, keep `local_safe` for Claude SDK in single-item mode first and enable batching only for direct providers.
- Confirm how `BullMqObservationQueueEngine` should represent dead-letter stats without overfitting SQLite internals.
- Confirm whether queue metrics should also broadcast through existing SSE status, or whether `GET /api/queue/status` is enough for the first patch.
- Confirm docs navigation conventions before editing `docs/public/docs.json`.
