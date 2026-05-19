# Context Overflow And LLM Settings UI Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development before implementing this plan. Keep edits small, preserve user memory data, and do not touch generated plugin UI bundles by hand.

**Goal:** Extend the local LLM queue backpressure branch so oversized prompts are split instead of lost or reset, and expose the queue/timing settings in the viewer Advanced tab through the real settings pipeline.

**Branch:** `codex/local-llm-queue-backpressure`

**Default context overflow limit:** `CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS=50000`

**Design choice:** Start with oversized current queued observations/tool outputs and staged summary jobs. Do not attempt broad conversation-history rewriting in this pass.

---

## Current Evidence

- The branch is intact after local branch cleanup: current branch is `codex/local-llm-queue-backpressure`, not detached, and Git object checks passed.
- The stray `.roo/mcp.json` and `.roo/rules/claude-mem-context.md` files were removed from the filesystem and Git index on 2026-05-17.
- The existing queue patch already adds `SmartLlmDrain`, queue pacing settings, retry/dead-letter behavior, queue status metrics, and docs.
- The web viewer settings modal lives in `src/ui/viewer/components/ContextSettingsModal.tsx`.
- Viewer settings are not automatically dynamic; new settings must be added to:
  - `src/ui/viewer/types.ts`
  - `src/ui/viewer/constants/settings.ts`
  - `src/ui/viewer/hooks/useSettings.ts`
  - `src/services/worker/http/routes/SettingsRoutes.ts`
- `/api/settings` uses an explicit allow-list in `SettingsRoutes.ts`, so UI fields are not real unless the route accepts and validates them.

## Progress Tracking

Overall progress: 99%

- [x] Task 1: Add context split settings. Status: complete. Progress: 100%.
- [x] Task 2: Build smart context splitter. Status: complete. Progress: 100%.
- [x] Task 3: Wire splitter into provider drain. Status: complete. Progress: 100%.
- [x] Task 4: Add Advanced tab LLM Queue section. Status: complete. Progress: 100%.
- [x] Task 5: Make UI fields real in `/api/settings`. Status: complete. Progress: 100%.
- [x] Task 6: Documentation and reboot note. Status: complete. Progress: 100%.
- [ ] Task 7: Validation. Status: focused checks, typechecks, shard isolation, and test-drift cleanup complete; broader repo gate currently blocked by logger-standards policy scope. Progress: 97%.

Progress notes:

- 2026-05-17: Phase 1 started with Superpowers subagent-driven development. Scope is settings defaults, parser options, `/api/settings` validation, and focused tests.
- 2026-05-17: Phase 1 completed. TDD added context split defaults, parser options, strict direct parser validation, strict `/api/settings` route validation, env override coverage, malformed numeric rejection coverage, and focused tests. Spec and quality subagent reviews both approved after one fix loop.
- 2026-05-17: Task 2 started with Superpowers subagent-driven development. Scope is `SmartLlmContextSplitter`, split metadata, prompt traceability, and focused splitter tests only; provider wiring remains Task 3.
- 2026-05-18: Task 2 completed. TDD added `SmartLlmContextSplitter`, split metadata, prompt traceability, conservative fallback behavior, and focused tests covering disabled splitting, oversized observations, command output, file-read output, protected errors, mixed stdout/stderr, max-part exhaustion, empty content, unrecognized structured responses, and source-boundary preservation. Spec and code-quality subagent reviews approved after fix loops.
- 2026-05-18: Task 3 started. Inspection found `processAgentResponse()` currently confirms all claimed queue rows after any valid parsed provider response, so splitter wiring must add deferred confirmation for split groups before provider-specific loops are changed.
- 2026-05-19: Task 3 completed. The splitter now runs after `SmartLlmDrain` and before provider sends in Claude, Gemini, and OpenRouter paths. Split parts preserve metadata, store observations part-by-part, and confirm original source IDs only after the final split part succeeds.
- 2026-05-19: Task 3 review fix added source-ID-scoped queue confirm/retry APIs so a buffered SmartLlmDrain lookahead row is not confirmed, retried, or dead-lettered by a split group it was not part of.
- 2026-05-19: Task 3 quality fix made scheduled retries time-aware: SQLite schedules retry wake timers and BullMQ moves future retries to delayed jobs. Added regression coverage for delayed retry wakeups, multiple SQLite delayed retries, and BullMQ delayed retry behavior.
- 2026-05-19: Tasks 4 and 5 completed. The viewer Advanced tab now exposes the local LLM queue/timing/context split settings, and `/api/settings` now allow-lists and validates every surfaced key with focused route coverage.
- 2026-05-19: Task 6 completed. Local LLM docs, public configuration docs, changelog, and `PROJECT-REBOOT.md` now describe the Advanced tab settings and default 50,000-character split limit.
- 2026-05-19: Task 7 focused validation completed. The focused queue/settings/parser/Windows-path compatibility suite passed with 192 pass, 4 skip, 0 fail, and `git diff --check` passed.
- 2026-05-19: Broader validation is blocked outside this phase: full `bun test` timed out after both 300-second and 600-second attempts, `npm run typecheck:root` still fails on known unrelated root files, and `npm run typecheck:viewer` still fails on known unrelated viewer files.
- 2026-05-19: Task 3 follow-up completed. Provider context-overflow errors are now classified as `context_overflow`; Gemini and OpenRouter retry an unsplit queued observation once with a smaller split budget, then use scoped queue retry/dead-letter handling if the smaller split still overflows. Claude SDK overflow dispatch now maps to the existing `overflow` hard-stop reason.
- 2026-05-19: Focused overflow validation passed: `bun test tests/worker/provider-errors.test.ts tests/worker/provider-classifiers.test.ts tests/gemini_provider.test.ts tests/claude-provider-error-classifier.test.ts tests/services/worker/llm/SmartLlmContextSplitter.test.ts tests/services/worker/llm/SmartLlmDrain.test.ts tests/worker/agents/response-processor.test.ts` reported 105 pass, 4 skip, 0 fail. `tests/services/worker/generator-exit-handler.test.ts` remains sandbox-blocked because it tries to write `C:\Users\ThorsHammer\.claude-mem\supervisor.json`.
- 2026-05-19: Review follow-up fixed partial split overflow behavior for Gemini/OpenRouter. If a later retry split part overflows after an earlier split part already stored observations, the provider clears split progress and hard-stops the session instead of retrying original queue IDs and duplicating stored data.
- 2026-05-19: Review follow-up fixed summary failure cleanup for Gemini/OpenRouter so a failed summary query removes the just-added summary prompt from `conversationHistory`.
- 2026-05-19: Targeted regression validation passed after review fixes: `bun test tests/gemini_provider.test.ts` reported 15 pass, 0 fail.
- 2026-05-19: Final cleanup checks passed for this pass: `git diff --check` exited 0, `git fsck --no-reflogs --connectivity-only` exited 0 with dangling objects only, and `Test-Path .roo` returned `False`.
- 2026-05-19: `npm run typecheck:root` still fails only on the known unrelated root type errors and did not report the provider/drain files changed in this review follow-up.
- 2026-05-19: Final review found two blockers: partial split invalid/non-XML output could retry original source IDs after earlier split parts stored, and Gemini/OpenRouter duplicated assistant responses in `conversationHistory`.
- 2026-05-19: Review blockers fixed. `processAgentResponse()` is now the single assistant-history append owner, invalid provider output is not appended to history, and partial split invalid/non-XML output after prior split storage now hard-stops without retrying original source IDs.
- 2026-05-19: Added OpenRouter provider coverage for partial split invalid hard-stop, summary prompt cleanup, and single assistant-history append.
- 2026-05-19: Full-suite isolation continued with sharded runs. Shards 1, 2, and 4 completed quickly but failed on existing broader-suite issues outside the queue/context-split path; shard 3 timed out after 300 seconds without `--bail`, then stopped immediately on an existing `HealthMonitor` mock failure with `--bail=1`, pointing to leaked handles after broader infrastructure failures rather than a queue-drain test timeout.
- 2026-05-19: Restored `plugin/hooks/codex-hooks.json` to the portable source form after approval; the accidental hardcoded encoded PowerShell/local-path diff is gone. `bun test tests/infrastructure/plugin-distribution.test.ts` passed with 25 pass, 0 fail.
- 2026-05-19: Final focused validation after hook cleanup passed: `bun test tests/infrastructure/plugin-distribution.test.ts tests/worker/provider-errors.test.ts tests/worker/provider-classifiers.test.ts tests/gemini_provider.test.ts tests/openrouter_provider.test.ts tests/claude-provider-error-classifier.test.ts tests/services/worker/llm/SmartLlmContextSplitter.test.ts tests/services/worker/llm/SmartLlmDrain.test.ts tests/worker/agents/response-processor.test.ts tests/worker/http/routes/settings-routes-context-split.test.ts tests/shared/settings-defaults-manager.test.ts` reported 181 pass, 4 skip, 0 fail.
- 2026-05-19: Typecheck drift cleanup completed. `npm run typecheck:root`, `npm run typecheck:viewer`, and `npm run typecheck` now pass after small fixes in install spinner calls, logger component typing, integration/session/http route types, executable lookup typing, and nullable viewer refs/timeouts.
- 2026-05-19: Targeted feature/regression validation passed after typecheck cleanup: `bun test tests/infrastructure/plugin-distribution.test.ts tests/worker/http/routes/corpus-routes-coercion.test.ts tests/worker/http/routes/data-routes-coercion.test.ts tests/worker/provider-errors.test.ts tests/worker/provider-classifiers.test.ts tests/gemini_provider.test.ts tests/openrouter_provider.test.ts tests/claude-provider-error-classifier.test.ts tests/services/worker/llm/SmartLlmContextSplitter.test.ts tests/services/worker/llm/SmartLlmDrain.test.ts tests/worker/agents/response-processor.test.ts tests/worker/http/routes/settings-routes-context-split.test.ts tests/shared/settings-defaults-manager.test.ts` reported 201 pass, 4 skip, 0 fail.
- 2026-05-19: Shard 1 re-isolation cleaned stale OpenClaw lifecycle tests, summarize-handler mocks, and v12.4.3 cleanup teardown. Focused checks passed: OpenClaw 43 pass; summarize-handler 16 pass; cleanup-v12.4.3 5 pass.
- 2026-05-19: Shard 1 now stops at `tests/logger-usage-standards.test.ts`. The test path matching now normalizes Windows paths correctly, but the remaining failure is a broad logger policy/scope gate covering unrelated CLI/user-output surfaces and high-priority logger-import coverage, not local LLM drain behavior.
- 2026-05-19: Final expanded focused validation passed: `bun test tests/infrastructure/plugin-distribution.test.ts tests/worker/http/routes/corpus-routes-coercion.test.ts tests/worker/http/routes/data-routes-coercion.test.ts tests/worker/provider-errors.test.ts tests/worker/provider-classifiers.test.ts tests/gemini_provider.test.ts tests/openrouter_provider.test.ts tests/claude-provider-error-classifier.test.ts tests/services/worker/llm/SmartLlmContextSplitter.test.ts tests/services/worker/llm/SmartLlmDrain.test.ts tests/worker/agents/response-processor.test.ts tests/worker/http/routes/settings-routes-context-split.test.ts tests/shared/settings-defaults-manager.test.ts openclaw/src/index.test.ts tests/cli/handlers/summarize-tag-stripping.test.ts tests/cli/handlers/summarize-subagent-skip.test.ts tests/infrastructure/cleanup-v12_4_3.test.ts --timeout=10000` reported 265 pass, 4 skip, 0 fail.
- 2026-05-19: Final cleanup checks passed: `npm run typecheck`, `git diff --check`, `Test-Path .roo` (`False`), and `git fsck --no-reflogs --connectivity-only` exited successfully with dangling objects only.

## New Settings

Add these settings to `SettingsDefaultsManager`, settings route validation, viewer state, docs, and tests:

```text
CLAUDE_MEM_LLM_CONTEXT_SPLIT_ENABLED=true
CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS=50000
CLAUDE_MEM_LLM_CONTEXT_SPLIT_MAX_PARTS=20
```

Keep these existing queue/backpressure settings visible in the UI:

```text
CLAUDE_MEM_MAX_CONCURRENT_AGENTS
CLAUDE_MEM_LLM_QUEUE_MODE
CLAUDE_MEM_LLM_MIN_SEND_INTERVAL_MS
CLAUDE_MEM_LLM_BATCH_MAX_ITEMS
CLAUDE_MEM_LLM_BATCH_MAX_CHARS
CLAUDE_MEM_LLM_COALESCE_WINDOW_MS
CLAUDE_MEM_LLM_ADAPTIVE_BACKOFF
CLAUDE_MEM_LLM_MAX_ATTEMPTS
CLAUDE_MEM_QUEUE_HIGH_WATERMARK
CLAUDE_MEM_QUEUE_CRITICAL_WATERMARK
CLAUDE_MEM_QUEUE_DROP_POLICY
CLAUDE_MEM_QUEUE_METRICS_ENABLED
```

## Context Overflow Design

Add context overflow handling inside the worker/provider drain path, close to `SmartLlmDrain`, before provider calls are made.

The splitter should:

- Estimate prompt size before send using characters first, with existing token estimation only where already available.
- Use `CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS` as the hard pre-send budget, defaulting to `50000`.
- Use `CLAUDE_MEM_LLM_CONTEXT_SPLIT_ENABLED=false` to preserve old behavior for debugging.
- Split only oversized current queue items or oversized drain batches in this pass.
- Preserve every original pending message ID in split metadata.
- Confirm source IDs only after all split parts represented by those IDs have been successfully parsed and stored.
- Retry split parts using the existing retry/dead-letter policy.
- Avoid splitting protected high-value messages unless the provider would otherwise reject them.
- Never silently drop summary jobs, user prompts, tool errors, build/test failures, file edits, auth errors, provider errors, or database errors.

Recommended split behavior:

```text
oversized drain item
  -> classify message type and safety
  -> split by prompt/tool/source boundaries where possible
  -> split command output by lines/sections
  -> split file reads by path and line windows
  -> split summary jobs into partial summaries and final rollup
  -> send each split part through provider pacing
  -> confirm only after all required parts succeed
```

Recommended split metadata:

```ts
interface SplitDrainMetadata {
  splitGroupId: string;
  splitIndex: number;
  splitTotal: number;
  originalSourceIds: number[];
  parentMessageType: string;
  reason: 'context_limit';
}
```

Prefer keeping split metadata in the synthetic prompt/drain item first. Add database columns only if implementation needs resumable split groups across process restarts.

## File Plan

Create:

- `src/services/worker/llm/SmartLlmContextSplitter.ts`
- `tests/services/worker/llm/SmartLlmContextSplitter.test.ts`

Modify:

- `src/services/worker/llm/SmartLlmDrain.ts`
- `src/services/worker/llm/SmartLlmDrainSettings.ts`
- `src/services/worker/llm/SmartLlmDrainPromptBuilder.ts`
- `src/shared/SettingsDefaultsManager.ts`
- `tests/shared/settings-defaults-manager.test.ts`
- `src/ui/viewer/types.ts`
- `src/ui/viewer/constants/settings.ts`
- `src/ui/viewer/hooks/useSettings.ts`
- `src/ui/viewer/components/ContextSettingsModal.tsx`
- `src/services/worker/http/routes/SettingsRoutes.ts`
- `tests/worker/http/routes/data-routes-coercion.test.ts`
- `docs/local-llm-queue.md`
- `docs/public/configuration.mdx`
- `PROJECT-REBOOT.md`

Do not manually edit:

- `plugin/ui/viewer-bundle.js`
- `plugin/ui/viewer.html`
- installed plugin cache copies under user profile directories

## Implementation Tasks

### Task 1: Add Context Split Settings

- [x] Add the three context split settings to `SettingsDefaultsManager`.
- [x] Extend `SmartLlmDrainOptions` or add a nested context split options type.
- [x] Parse and clamp settings in `SmartLlmDrainSettings.ts`.
- [x] Validate:
  - `CLAUDE_MEM_LLM_CONTEXT_SPLIT_ENABLED` is `"true"` or `"false"`.
  - `CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS` is between `1000` and `1000000`.
  - `CLAUDE_MEM_LLM_CONTEXT_SPLIT_MAX_PARTS` is between `1` and `100`.
- [x] Add tests for defaults, env override, invalid input clamp, and route validation.

Task 1 completion notes:

- Added defaults: `CLAUDE_MEM_LLM_CONTEXT_SPLIT_ENABLED=true`, `CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS=50000`, and `CLAUDE_MEM_LLM_CONTEXT_SPLIT_MAX_PARTS=20`.
- Added nested `contextSplit` options to `SmartLlmDrainOptions`.
- Added strict integer parsing so malformed strings such as `75000abc` and `12abc` are rejected or treated as invalid.
- Focused validation: `bun test tests/shared/settings-defaults-manager.test.ts tests/services/worker/llm/SmartLlmDrain.test.ts tests/worker/http/routes/settings-routes-context-split.test.ts` passed with 52 pass, 0 fail.

### Task 2: Build Smart Context Splitter

- [x] Implement `SmartLlmContextSplitter`.
- [x] Accept a `DrainItem` and return one or more sendable drain items.
- [x] Preserve original source IDs on every split part.
- [x] Add stable split group metadata to prompts so parser/debug logs can trace each part.
- [x] Split by prompt/tool/source boundaries first, then by line windows as fallback.
- [x] Keep protected message classifications from `SmartLlmDrain` intact.
- [x] Add unit tests for oversized observation, command output, file-read output, protected error output, and disabled splitting.

Task 2 completion notes:

- Added `SmartLlmContextSplitter` as a standalone component; provider/drain-loop wiring remains Task 3.
- Added split metadata to drain items and prompt building so split group, index, total, source IDs, parent type, and reason are visible to parser/debug paths.
- Added conservative fallback to the original drain item when splitting would return zero parts, lose source IDs, exceed `maxParts`, produce over-budget chunks, lack splittable content, or drop unrecognized structured data.
- Focused validation: `bun test tests/services/worker/llm/SmartLlmContextSplitter.test.ts tests/services/worker/llm/SmartLlmDrain.test.ts` passed with 29 pass, 0 fail.

### Task 3: Wire Splitter Into Provider Drain

- [x] Run splitter after batching/coalescing and before provider sends.
- [x] Keep existing pacing and adaptive backoff behavior unchanged.
- [x] On provider context overflow errors, retry once with a smaller split budget before using the normal retry/dead-letter path.
- [x] Confirm original source IDs only when all parts tied to those IDs succeeded.
- [x] Make partial split failure visible in queue metrics/logs.

Task 3 completion notes:

- Wired `SmartLlmContextSplitter` into `ClaudeProvider`, `GeminiProvider`, and `OpenRouterProvider` for observation drain items while preserving the summary path.
- Added split-aware response processing so non-final split parts store observations but defer queue confirmation until all split parts succeed.
- Added scoped queue operations (`confirmClaimedMessageIds` and `retryOrFailClaimedMessageIds`) so lookahead claims are preserved when a split group succeeds or fails.
- Fixed delayed retry scheduling so SQLite wakes iterators at retry availability and BullMQ uses delayed jobs for future retries.
- Added shared context-overflow classification plus a one-shot smaller-budget retry for Gemini/OpenRouter direct provider sends; if the smaller retry also overflows, the source IDs go through `retryOrFailClaimedMessageIds(...)` instead of bubbling into a session restart loop.
- Added partial split overflow protection for Gemini/OpenRouter direct provider sends; once a split part has already stored observations, a later provider context overflow now hard-stops instead of retrying/dead-lettering the original source IDs.
- Added partial split invalid-output protection so a later empty/non-XML split response after prior split storage also hard-stops instead of retrying/dead-lettering original source IDs.
- Made `processAgentResponse()` the single owner for assistant-history appends; Gemini/OpenRouter no longer append provider responses directly, and invalid provider output is not retained in `conversationHistory`.
- Added summary provider failure cleanup for Gemini/OpenRouter so failed summary sends do not leave failed summary prompts in `conversationHistory`.
- Claude SDK context-overflow dispatch now uses the existing `overflow` hard-stop reason instead of the generic restart path.
- Claude SDK overflow retry parity is not implemented in this pass. Claude still pre-splits before SDK sends and classifies SDK overflow as `context_overflow`/`overflow`; the smaller-budget resend is currently limited to direct-fetch providers where the worker owns each provider send call.
- Focused validation: `bun test tests/services/worker/llm/SmartLlmContextSplitter.test.ts tests/services/worker/llm/SmartLlmDrain.test.ts tests/worker/agents/response-processor.test.ts tests/services/worker/session-manager-queue.test.ts tests/gemini_provider.test.ts tests/services/queue/ObservationQueueEngine.contract.test.ts tests/services/queue/bullmq-observation-queue-engine.test.ts` passed with 91 pass, 5 skip, 0 fail.
- Focused overflow validation: `bun test tests/worker/provider-errors.test.ts tests/worker/provider-classifiers.test.ts tests/gemini_provider.test.ts tests/openrouter_provider.test.ts tests/claude-provider-error-classifier.test.ts tests/services/worker/llm/SmartLlmContextSplitter.test.ts tests/services/worker/llm/SmartLlmDrain.test.ts tests/worker/agents/response-processor.test.ts` passed with 111 pass, 4 skip, 0 fail.
- Targeted review-regression validation: `bun test tests/gemini_provider.test.ts` passed with 15 pass, 0 fail.
- Targeted direct-provider regression validation: `bun test tests/openrouter_provider.test.ts tests/worker/agents/response-processor.test.ts tests/gemini_provider.test.ts` passed with 40 pass, 4 skip, 0 fail.

### Task 4: Add Advanced Tab LLM Queue Section

- [x] Add settings fields to `src/ui/viewer/types.ts`.
- [x] Add defaults to `src/ui/viewer/constants/settings.ts`.
- [x] Map load/save values in `src/ui/viewer/hooks/useSettings.ts`.
- [x] Add a nested "LLM Queue & Timing" section under the existing Advanced collapsible in `ContextSettingsModal.tsx`.
- [x] Use existing `FormField` and `ToggleSwitch` patterns.
- [x] Include controls for queue mode, concurrency, min interval, batch limits, coalesce window, context max chars, split enabled, split max parts, adaptive backoff, attempts, watermarks, drop policy, and metrics.
- [x] Keep labels concise and tooltips clear; do not add a marketing/help panel.

Task 4 completion notes:

- Added queue/timing/context split fields to viewer `Settings`, viewer defaults, and `useSettings` load mapping.
- Added an Advanced tab "LLM Queue & Timing" subsection in `ContextSettingsModal.tsx` using the existing `FormField` and `ToggleSwitch` patterns.
- Covered concurrency, queue mode, min interval, batch limits, coalesce window, retry attempts, context split toggles and budgets, watermarks, drop policy, adaptive backoff, and metrics.

### Task 5: Make UI Fields Real In `/api/settings`

- [x] Add all queue/timing/context split keys to the `settingKeys` allow-list in `SettingsRoutes.ts`.
- [x] Add enum validation for:
  - `CLAUDE_MEM_LLM_QUEUE_MODE`: `off`, `auto`, `local_safe`
  - `CLAUDE_MEM_QUEUE_DROP_POLICY`: `coalesce_low_value`
- [x] Add boolean validation for:
  - `CLAUDE_MEM_LLM_ADAPTIVE_BACKOFF`
  - `CLAUDE_MEM_QUEUE_METRICS_ENABLED`
  - `CLAUDE_MEM_LLM_CONTEXT_SPLIT_ENABLED`
- [x] Add numeric validation for all timing, batch, context, retry, watermark, and concurrency fields.
- [x] Add route tests that prove each new UI field persists to settings JSON.

Task 5 completion notes:

- Extended the `/api/settings` allow-list for queue mode, concurrency, pacing, batching, coalescing, adaptive backoff, retry cap, context split settings, watermarks, drop policy, and metrics.
- Added strict enum, boolean, integer range, malformed numeric string, and critical-watermark-order validation.
- Focused validation: `bun test tests/worker/http/routes/settings-routes-context-split.test.ts` passed with 11 pass, 0 fail.

### Task 6: Documentation And Reboot Note

- [x] Update local LLM docs with the default context limit and weak-local-model tuning notes.
- [x] Add the Advanced tab setting list to public configuration docs.
- [x] Update `PROJECT-REBOOT.md` with the new plan and next action.

Task 6 completion notes:

- Updated `docs/local-llm-queue.md` with context split defaults, the 50,000-character limit, and the Advanced tab location.
- Updated `docs/public/configuration.mdx` with all local LLM queue/timing/context split settings surfaced in the viewer.
- Updated `CHANGELOG.md` and `PROJECT-REBOOT.md` so a new thread can resume at validation.

### Task 7: Validation

- [x] Run focused queue/context/settings route tests.
- [x] Run focused provider context-overflow retry tests.
- [x] Run parser compatibility tests after broader validation exposed the additive contract mismatch.
- [x] Run Windows source-path compatibility tests after broader validation exposed URL pathname failures.
- [x] Run `git diff --check`.
- [x] Run `npm run typecheck:root` for evidence.
- [x] Run `npm run typecheck:viewer` for evidence.
- [ ] Resolve or explicitly waive the broad logger-standards policy gate.
- [ ] Get full `bun test` to complete in this environment.

Run focused checks first:

```powershell
bun test tests/services/worker/llm/SmartLlmDrain.test.ts
bun test tests/services/worker/llm/SmartLlmContextSplitter.test.ts
bun test tests/shared/settings-defaults-manager.test.ts
bun test tests/worker/http/routes/data-routes-coercion.test.ts
```

Then run broader checks:

```powershell
bun test
npm run typecheck:root
```

Known risk: `npm run typecheck:root` had unrelated pre-existing failures on this branch before this follow-up plan. Re-run it for evidence, but do not confuse old type errors with this work.

Task 7 validation notes:

- Focused validation passed: `bun test tests/worker/http/routes/settings-routes-context-split.test.ts tests/shared/settings-defaults-manager.test.ts tests/services/worker/llm/SmartLlmDrain.test.ts tests/services/worker/llm/SmartLlmContextSplitter.test.ts tests/worker/http/routes/data-routes-coercion.test.ts tests/sdk/parser.test.ts tests/sdk/parse-summary.test.ts tests/servers/mcp-tool-schemas.test.ts tests/hook-lifecycle.test.ts tests/worker/agents/response-processor.test.ts` reported 192 pass, 4 skip, 0 fail.
- Focused provider overflow validation passed: `bun test tests/worker/provider-errors.test.ts tests/worker/provider-classifiers.test.ts tests/gemini_provider.test.ts tests/openrouter_provider.test.ts tests/claude-provider-error-classifier.test.ts tests/services/worker/llm/SmartLlmContextSplitter.test.ts tests/services/worker/llm/SmartLlmDrain.test.ts tests/worker/agents/response-processor.test.ts` reported 111 pass, 4 skip, 0 fail.
- Direct-provider regression validation passed: `bun test tests/openrouter_provider.test.ts tests/worker/agents/response-processor.test.ts tests/gemini_provider.test.ts` reported 40 pass, 4 skip, 0 fail.
- `bun test tests/services/worker/generator-exit-handler.test.ts` was attempted as an extra guard and failed from sandbox filesystem access to `C:\Users\ThorsHammer\.claude-mem\supervisor.json`, not from an assertion in the overflow behavior.
- `git diff --check` passed.
- `git fsck --no-reflogs --connectivity-only` exited 0 with dangling objects only.
- `Test-Path .roo` returned `False`.
- `npm run typecheck:root`, `npm run typecheck:viewer`, and `npm run typecheck` pass after typecheck drift cleanup.
- Final expanded focused validation passed with 265 pass, 4 skip, 0 fail.
- Final cleanup checks passed: `npm run typecheck`, `git diff --check`, `.roo` absent, and `git fsck --no-reflogs --connectivity-only` successful with dangling objects only.
- Full `bun test` was attempted twice and timed out after 300 seconds and 600 seconds in this environment.
- Hook distribution validation passed after restoring portable Codex hooks: `bun test tests/infrastructure/plugin-distribution.test.ts` reported 25 pass, 0 fail.
- Final focused feature/distribution validation passed after cleanup: 181 pass, 4 skip, 0 fail.
- Fresh `git fsck --no-reflogs --connectivity-only` exited 0 with dangling objects only.
- Sharded full-suite evidence:
  - `bun test --parallel=1 --timeout=10000 --shard=1/4` completed with 544 pass, 8 skip, 28 fail. Failures included OpenClaw observation I/O, summarize-handler module mocking around `fetchWithTimeout`, v12.4.3 cleanup, hook distribution, logger standards, Chroma singleton, and generator-exit sandbox access.
  - `bun test --parallel=1 --timeout=10000 --shard=2/4` completed with 370 pass, 12 skip, 66 fail. Failures included GracefulShutdown, ProcessManager, Cursor transcript extraction, WelcomeCard storage, and `writeJsonFileAtomic` mode preservation.
  - `bun test --parallel=1 --timeout=10000 --shard=3/4` timed out after 300 seconds. A rerun with `--bail=1` stopped immediately at `HealthMonitor > isPortInUse`, indicating the long run is likely leaked handles after continuing through existing infrastructure failures.
  - `bun test --parallel=1 --timeout=10000 --shard=4/4` completed with 421 pass, 1 skip, 11 fail. Failures included summarize subagent short-circuit tests, FK constraint tests, schema repair, and worker-start validation guards.
- Current shard 1 re-isolation: `bun test --parallel=1 --timeout=10000 --bail=1 --shard=1/4` now progresses past OpenClaw, summarize-handler, and v12.4.3 cleanup, then stops at `tests/logger-usage-standards.test.ts`.

## Acceptance Criteria

- `CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS` defaults to `50000` and is configurable.
- Oversized queue items split before provider send instead of being dropped or reset forever.
- Split parts preserve original source IDs and can be traced by split group metadata.
- Source IDs are confirmed only after all required split parts succeed.
- Summary jobs are preserved through staged summary behavior.
- The Advanced tab has a real "LLM Queue & Timing" section.
- Every UI field maps to `Settings`, viewer defaults, `useSettings`, `/api/settings`, validation, and `SettingsDefaultsManager`.
- No manual edits are made to generated viewer bundles or installed plugin cache copies.
- `.roo` files remain removed unless the user explicitly asks to restore them.
