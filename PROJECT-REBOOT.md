# Project Reboot: Local LLM Queue Backpressure

Date: 2026-05-15
Branch: `codex/local-llm-queue-backpressure`
Plan: `plans/2026-05-15-local-llm-queue-backpressure.md`
Follow-up Plan: `plans/2026-05-17-context-overflow-and-llm-settings-ui.md`

## Current Status

- Branch created from clean `main`.
- Planning inspection confirmed this checkout does not have `src/services/worker/SDKAgent.ts`; the active provider paths are `ClaudeProvider.ts`, `GeminiProvider.ts`, and `OpenRouterProvider.ts`.
- Current queue flow is persistent SQLite/BullMQ queue -> `SessionManager.getMessageIterator()` -> provider prompt loop -> `processAgentResponse()` -> session-level confirm/reset.
- Current `pending_messages.status` only supports `pending` and `processing`.
- Task 1 complete: LLM queue settings defaults were added to `SettingsDefaultsManager`, with `tests/shared/settings-defaults-manager.test.ts` passing.
- Task 2 complete: additive queue metadata columns, `pending_message_dead_letters`, migration version 35, authoritative schema updates, and SessionStore mirror were added; migration and pending-message tests pass.
- Task 3 complete: queue store operations were added for batch confirm, retry scheduling, dead-letter movement, delayed claim handling, and queue stats; SQLite/BullMQ queue contract tests pass.
- Task 4 complete: `SmartLlmDrain`, settings parsing, batch/coalesce prompt building, adaptive metrics, and source-ID preservation tests were added.
- Task 5 complete: `ClaudeProvider`, `GeminiProvider`, and `OpenRouterProvider` now drain through `SmartLlmDrain`; empty/non-XML provider output uses bounded retry/dead-letter behavior instead of confirming rows.
- Task 6 complete: `GET /api/queue/status` exposes queue pressure, per-session stats, and latest provider drain metrics; processing-status SSE now includes queue stats as an additive field.
- Task 8 started: local LLM queue tuning docs were added in `docs/local-llm-queue.md` and configuration docs were updated.
- 2026-05-17 follow-up planning added a configurable context-overflow splitter with default `CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS=50000`.
- 2026-05-17 follow-up planning added a viewer Advanced tab "LLM Queue & Timing" settings section that must be wired to the real `/api/settings` allow-list and validation path.
- Stray `.roo/mcp.json` and `.roo/rules/claude-mem-context.md` files were removed from the filesystem and Git index at the user's request.
- 2026-05-17 Phase 1 complete: context split settings defaults, nested drain options, strict direct parser validation, strict `/api/settings` route validation, env override tests, malformed numeric rejection tests, and focused validation were added.
- Focused Phase 1 validation passed: `bun test tests/shared/settings-defaults-manager.test.ts tests/services/worker/llm/SmartLlmDrain.test.ts tests/worker/http/routes/settings-routes-context-split.test.ts` reported 52 pass, 0 fail.
- 2026-05-18 Task 2 complete: `SmartLlmContextSplitter`, split metadata, prompt traceability, conservative fallback behavior, and focused splitter tests were added.
- Focused Task 2 validation passed: `bun test tests/services/worker/llm/SmartLlmContextSplitter.test.ts tests/services/worker/llm/SmartLlmDrain.test.ts` reported 29 pass, 0 fail.
- Root typecheck was rerun during Task 2 review; it still fails on known unrelated files, and the current output did not mention `SmartLlmContextSplitter.ts`.
- 2026-05-19 Task 3 complete: `SmartLlmContextSplitter` is wired into Claude, Gemini, and OpenRouter observation drain paths after `SmartLlmDrain` batching/coalescing and before provider sends.
- 2026-05-19 Task 3 added split-aware `processAgentResponse()` behavior so non-final split parts store observations but defer queue confirmation until the final split part succeeds.
- 2026-05-19 Task 3 added scoped queue confirm/retry helpers and claim timestamp tracking so buffered SmartLlmDrain lookahead rows are not confirmed, retried, or dead-lettered by another split group.
- 2026-05-19 Task 3 fixed delayed retry scheduling: SQLite now wakes iterators when scheduled retries become available, and BullMQ future retries use delayed jobs instead of immediate wait requeue.
- Focused Task 3 validation passed: `bun test tests/services/worker/llm/SmartLlmContextSplitter.test.ts tests/services/worker/llm/SmartLlmDrain.test.ts tests/worker/agents/response-processor.test.ts tests/services/worker/session-manager-queue.test.ts tests/gemini_provider.test.ts tests/services/queue/ObservationQueueEngine.contract.test.ts tests/services/queue/bullmq-observation-queue-engine.test.ts` reported 91 pass, 5 skip, 0 fail.
- 2026-05-19 Task 4 complete: the viewer Advanced tab now has an "LLM Queue & Timing" section wired through `Settings`, viewer defaults, `useSettings`, and existing form controls.
- 2026-05-19 Task 5 complete: `/api/settings` now accepts and validates local LLM queue/timing/context split settings, including enum, boolean, strict numeric, and watermark ordering checks.
- 2026-05-19 Task 6 complete: local LLM docs, public configuration docs, changelog, and this reboot note were updated for the Advanced tab settings and default 50,000-character context split limit.
- 2026-05-19 validation follow-up fixed two existing Windows/test compatibility issues found during broader checks: source-reading tests now use `fileURLToPath()`, and `parseAgentXml()` again exposes additive `kind`, `data`, and invalid `reason` fields.
- Focused validation passed after the follow-up fixes: `bun test tests/worker/http/routes/settings-routes-context-split.test.ts tests/shared/settings-defaults-manager.test.ts tests/services/worker/llm/SmartLlmDrain.test.ts tests/services/worker/llm/SmartLlmContextSplitter.test.ts tests/worker/http/routes/data-routes-coercion.test.ts tests/sdk/parser.test.ts tests/sdk/parse-summary.test.ts tests/servers/mcp-tool-schemas.test.ts tests/hook-lifecycle.test.ts tests/worker/agents/response-processor.test.ts` reported 192 pass, 4 skip, 0 fail.
- 2026-05-19 Task 3 overflow follow-up complete: provider context overflow is now classified as `context_overflow`; Gemini and OpenRouter retry an unsplit item once with a smaller split budget and then call scoped queue retry/dead-letter handling if the smaller split still overflows.
- 2026-05-19 review follow-up fixed partial split overflow handling: Gemini and OpenRouter now hard-stop instead of retrying original queue IDs if a later retry split part overflows after an earlier part already stored observations.
- 2026-05-19 review follow-up fixed Gemini/OpenRouter summary failure cleanup so failed summary provider calls remove the just-added summary prompt from `conversationHistory`.
- 2026-05-19 final review found and the branch now fixes two additional blockers: later split empty/non-XML output after prior split storage now hard-stops without retrying original source IDs, and `processAgentResponse()` is the single owner for assistant history appends.
- Invalid provider output is no longer appended to `conversationHistory`, and Gemini/OpenRouter no longer append assistant responses directly before `processAgentResponse()`.
- OpenRouter provider coverage was added for partial split invalid hard-stop, summary prompt cleanup, and single assistant-history append.
- Targeted review-regression validation passed: `bun test tests/gemini_provider.test.ts` reported 15 pass, 0 fail.
- Targeted direct-provider regression validation passed: `bun test tests/openrouter_provider.test.ts tests/worker/agents/response-processor.test.ts tests/gemini_provider.test.ts` reported 40 pass, 4 skip, 0 fail.
- 2026-05-19 Claude SDK overflow dispatch now maps to the existing `overflow` hard-stop reason so it does not enter the generic pending-work restart path.
- Claude SDK overflow retry parity is not implemented in this pass; Claude still pre-splits before SDK sends and treats SDK context overflow as an `overflow` hard-stop, while the one-shot smaller-budget resend is limited to Gemini/OpenRouter direct provider sends.
- Focused overflow validation passed: `bun test tests/worker/provider-errors.test.ts tests/worker/provider-classifiers.test.ts tests/gemini_provider.test.ts tests/openrouter_provider.test.ts tests/claude-provider-error-classifier.test.ts tests/services/worker/llm/SmartLlmContextSplitter.test.ts tests/services/worker/llm/SmartLlmDrain.test.ts tests/worker/agents/response-processor.test.ts` reported 111 pass, 4 skip, 0 fail.
- Extra generator-exit validation was attempted with `bun test tests/services/worker/generator-exit-handler.test.ts`; it is sandbox-blocked by EPERM writing `C:\Users\ThorsHammer\.claude-mem\supervisor.json`.
- `git diff --check` passed.
- `git fsck --no-reflogs --connectivity-only` exited 0 with dangling objects only, so branch connectivity still checks out after the user's local branch cleanup.
- `Test-Path .roo` returned `False`.
- Full `bun test` was attempted with 300-second and 600-second timeouts; it did not complete before timeout in this environment.
- Full-suite isolation was continued with sharded runs. Shards 1, 2, and 4 completed quickly but failed on broader existing test-suite issues outside the queue/context-split path; shard 3 timed out after 300 seconds without `--bail`, then stopped immediately on an existing `HealthMonitor` mock failure with `--bail=1`.
- Shard 1 evidence: `bun test --parallel=1 --timeout=10000 --shard=1/4` completed with 544 pass, 8 skip, 28 fail. Failures included OpenClaw observation I/O, summarize-handler module mocking around `fetchWithTimeout`, v12.4.3 cleanup, hook distribution, logger standards, Chroma singleton, and generator-exit sandbox access.
- Shard 2 evidence: `bun test --parallel=1 --timeout=10000 --shard=2/4` completed with 370 pass, 12 skip, 66 fail. Failures included GracefulShutdown, ProcessManager, Cursor transcript extraction, WelcomeCard storage, and `writeJsonFileAtomic` mode preservation.
- Shard 3 evidence: `bun test --parallel=1 --timeout=10000 --shard=3/4` timed out after 300 seconds. `bun test --parallel=1 --timeout=10000 --bail=1 --shard=3/4` stopped at `HealthMonitor > isPortInUse`, indicating leaked handles after continuing through existing infrastructure failures rather than a queue-drain test hang.
- Shard 4 evidence: `bun test --parallel=1 --timeout=10000 --shard=4/4` completed with 421 pass, 1 skip, 11 fail. Failures included summarize subagent short-circuit tests, FK constraint tests, schema repair, and worker-start validation guards.
- Final focused validation after hook cleanup passed: `bun test tests/infrastructure/plugin-distribution.test.ts tests/worker/provider-errors.test.ts tests/worker/provider-classifiers.test.ts tests/gemini_provider.test.ts tests/openrouter_provider.test.ts tests/claude-provider-error-classifier.test.ts tests/services/worker/llm/SmartLlmContextSplitter.test.ts tests/services/worker/llm/SmartLlmDrain.test.ts tests/worker/agents/response-processor.test.ts tests/worker/http/routes/settings-routes-context-split.test.ts tests/shared/settings-defaults-manager.test.ts` reported 181 pass, 4 skip, 0 fail.
- 2026-05-19 merge-readiness cleanup fixed root/viewer typecheck drift in Clack spinner usage, logger component typing, OpenClaw/Cursor integration types, stale SessionStore import, Express 5 route parameter coercion, find-claude executable typing, and nullable viewer refs/timeouts.
- `npm run typecheck:root`, `npm run typecheck:viewer`, and `npm run typecheck` now pass.
- Current targeted feature/regression validation passed: `bun test tests/infrastructure/plugin-distribution.test.ts tests/worker/http/routes/corpus-routes-coercion.test.ts tests/worker/http/routes/data-routes-coercion.test.ts tests/worker/provider-errors.test.ts tests/worker/provider-classifiers.test.ts tests/gemini_provider.test.ts tests/openrouter_provider.test.ts tests/claude-provider-error-classifier.test.ts tests/services/worker/llm/SmartLlmContextSplitter.test.ts tests/services/worker/llm/SmartLlmDrain.test.ts tests/worker/agents/response-processor.test.ts tests/worker/http/routes/settings-routes-context-split.test.ts tests/shared/settings-defaults-manager.test.ts` reported 201 pass, 4 skip, 0 fail.
- OpenClaw verification cleanup aligned stale lifecycle tests with the documented current behavior: `session_start` and `after_compaction` are tracking-only, and `before_agent_start` initializes the worker session. `bun test openclaw/src/index.test.ts --timeout=10000` reported 43 pass, 0 fail.
- Summarize-handler test mocks were refreshed for the current worker-utils/server-beta import graph and settings shape. `bun test tests/cli/handlers/summarize-tag-stripping.test.ts tests/cli/handlers/summarize-subagent-skip.test.ts --timeout=10000` reported 16 pass, 0 fail.
- The v12.4.3 cleanup test now checkpoints seeded WAL data and uses GC-backed temp cleanup retry to avoid Windows/Bun SQLite teardown races. `bun test tests/infrastructure/cleanup-v12_4_3.test.ts --timeout=10000` reported 5 pass, 0 fail.
- Final expanded focused validation passed: `bun test tests/infrastructure/plugin-distribution.test.ts tests/worker/http/routes/corpus-routes-coercion.test.ts tests/worker/http/routes/data-routes-coercion.test.ts tests/worker/provider-errors.test.ts tests/worker/provider-classifiers.test.ts tests/gemini_provider.test.ts tests/openrouter_provider.test.ts tests/claude-provider-error-classifier.test.ts tests/services/worker/llm/SmartLlmContextSplitter.test.ts tests/services/worker/llm/SmartLlmDrain.test.ts tests/worker/agents/response-processor.test.ts tests/worker/http/routes/settings-routes-context-split.test.ts tests/shared/settings-defaults-manager.test.ts openclaw/src/index.test.ts tests/cli/handlers/summarize-tag-stripping.test.ts tests/cli/handlers/summarize-subagent-skip.test.ts tests/infrastructure/cleanup-v12_4_3.test.ts --timeout=10000` reported 265 pass, 4 skip, 0 fail.
- Final cleanup checks passed: `npm run typecheck`, `git diff --check`, `Test-Path .roo` (`False`), and `git fsck --no-reflogs --connectivity-only` exited successfully. `git fsck` reported dangling objects only.
- Fresh shard 1 re-isolation now progresses past OpenClaw, summarize-handler, and v12.4.3 cleanup blockers, then stops at `tests/logger-usage-standards.test.ts`. Path normalization was fixed in that test, but the remaining logger policy failure is a broad repo gate covering existing CLI/user-output files and high-priority logger-import coverage, not local LLM queue behavior.
- Fresh `git fsck --no-reflogs --connectivity-only` exited 0 with dangling objects only.
- `plugin/hooks/codex-hooks.json` was restored to the portable source form after approval, removing the hardcoded encoded PowerShell/local-path diff. `bun test tests/infrastructure/plugin-distribution.test.ts` passed with 25 pass, 0 fail.

## Safety Constraints

- Do not delete or reset `~/.claude-mem` or `claude-mem.db`.
- Do not touch installed plugin cache copies until source changes, tests, and build are validated.
- Keep hook ingestion fast; fix provider drain behavior in the worker.
- Add schema changes as additive migrations when possible.
- Keep exact source queue IDs through batching/coalescing and confirm only after successful parse/store.

## Next Action

Continue with merge-readiness cleanup: decide whether the broad logger-standards policy test should be addressed in this branch or accepted as out-of-scope before preparing a PR.

## Open Gaps

- Add a full fake slow-provider integration test that enqueues 200 observations and verifies gradual drain behavior.
- Decide whether BullMQ dead-letter behavior should be native BullMQ failed jobs or mirrored metrics only.
- Add staged summary behavior for oversized summary work.
- Add Claude SDK retry parity only if the SDK generator path exposes a safe per-item retry boundary; current behavior is pre-split then hard-stop on SDK context overflow.
- Full `bun test` does not complete within 10 minutes in this environment; isolate remaining long-running or order-sensitive suite issues before requiring it as a merge gate.
- Sharded full-suite runs show the timeout is tied to broader infrastructure failures and leaked handles, not the focused queue/context-split path.
- `tests/logger-usage-standards.test.ts` remains the current shard 1 blocker after Windows path normalization; it needs a separate policy/scope decision because it covers many unrelated CLI/user-output and logger-coverage surfaces.
