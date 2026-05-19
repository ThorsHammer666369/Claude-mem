# Local LLM Queue Backpressure

Claude-Mem keeps hook ingestion fast by writing observations to the persistent
queue first. Slow local providers should be protected at the worker drain layer,
not by slowing hook execution.

## Recommended Local Profile

Use this profile for small or CPU-bound local models:

```json
{
  "CLAUDE_MEM_MAX_CONCURRENT_AGENTS": "1",
  "CLAUDE_MEM_LLM_QUEUE_MODE": "local_safe",
  "CLAUDE_MEM_LLM_MIN_SEND_INTERVAL_MS": "1500",
  "CLAUDE_MEM_LLM_BATCH_MAX_ITEMS": "1",
  "CLAUDE_MEM_LLM_BATCH_MAX_CHARS": "12000",
  "CLAUDE_MEM_LLM_COALESCE_WINDOW_MS": "5000",
  "CLAUDE_MEM_LLM_ADAPTIVE_BACKOFF": "true",
  "CLAUDE_MEM_LLM_CONTEXT_SPLIT_ENABLED": "true",
  "CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS": "50000",
  "CLAUDE_MEM_LLM_CONTEXT_SPLIT_MAX_PARTS": "20"
}
```

Do not raise `CLAUDE_MEM_MAX_CONCURRENT_AGENTS` on weak local hardware unless the
provider can handle parallel requests.

The same worker-side queue, timing, retry, and context split settings are
available in the viewer settings modal under Advanced -> LLM Queue & Timing.

## Queue Drain Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_MEM_LLM_QUEUE_MODE` | `auto` | `off`, `auto`, or `local_safe` pacing behavior |
| `CLAUDE_MEM_LLM_MIN_SEND_INTERVAL_MS` | `0` | Minimum delay before sending a drained queue item to the provider |
| `CLAUDE_MEM_LLM_BATCH_MAX_ITEMS` | `3` | Maximum compatible low-value observations per batch |
| `CLAUDE_MEM_LLM_BATCH_MAX_CHARS` | `24000` | Prompt budget for one drained item |
| `CLAUDE_MEM_LLM_COALESCE_WINDOW_MS` | `5000` | Window used when repeated low-value observations are coalesced |
| `CLAUDE_MEM_LLM_ADAPTIVE_BACKOFF` | `true` | Increase delay after empty, timeout, or parser failures |
| `CLAUDE_MEM_LLM_MAX_ATTEMPTS` | `3` | Retry cap before moving a bad queued row to dead-letter storage |
| `CLAUDE_MEM_LLM_CONTEXT_SPLIT_ENABLED` | `true` | Split oversized queued prompts before provider send |
| `CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS` | `50000` | Default pre-send context budget for one provider request |
| `CLAUDE_MEM_LLM_CONTEXT_SPLIT_MAX_PARTS` | `20` | Maximum split parts generated from one oversized drain item |
| `CLAUDE_MEM_QUEUE_HIGH_WATERMARK` | `200` | Queue depth where pressure behavior starts |
| `CLAUDE_MEM_QUEUE_CRITICAL_WATERMARK` | `1000` | Queue depth reported as critical pressure |
| `CLAUDE_MEM_QUEUE_DROP_POLICY` | `coalesce_low_value` | Policy label exposed in queue status |
| `CLAUDE_MEM_QUEUE_METRICS_ENABLED` | `true` | Enables queue/provider pressure metrics |

The default `auto` mode keeps cloud-provider behavior compatible by using no
minimum delay unless queue pressure crosses the high watermark. `local_safe`
always applies the configured minimum send interval.

## Context Overflow Behavior

Oversized queued observations are split before provider sends when
`CLAUDE_MEM_LLM_CONTEXT_SPLIT_ENABLED` is `true`. The default split budget is
`CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS=50000`.

Gemini and OpenRouter also classify provider prompt/context-length errors as
`context_overflow`. When an unsplit queued observation gets that error, the
worker retries it once with a smaller split budget. If the smaller retry
overflows before any split part stores, the original source IDs follow the
normal retry/dead-letter policy.

If a later retry split part overflows after earlier split parts already stored
observations, the worker hard-stops that session instead of retrying the
original queue IDs. That avoids duplicating already stored split observations.
The same hard-stop rule applies when a later split part returns empty or
non-XML output after earlier split parts already stored.

Claude SDK sessions still use pre-send splitting and classify SDK context
overflow as an `overflow` hard-stop. The smaller-budget resend is currently
limited to direct-fetch providers where the worker owns each provider request.

## Observability

Use the worker endpoint to inspect pressure and provider drain state:

```powershell
curl http://127.0.0.1:37777/api/queue/status
```

The response includes total pending, processing, delayed, and failed counts,
oldest pending age, per-session queue stats, current provider backoff, and the
configured high and critical watermarks.

Invalid, empty, or non-XML provider responses are retried up to
`CLAUDE_MEM_LLM_MAX_ATTEMPTS`. After the cap, claimed rows are copied to
`pending_message_dead_letters` and removed from the active pending queue so a
single bad row cannot loop forever.
