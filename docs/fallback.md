# Provider Fallback

Automatic install-wide failover to a backup LLM provider when the native
provider (Claude) hits a real usage limit — quota exhausted, billing failure,
or persistent API overload. Transient per-minute rate limits do **not**
trigger a switch.

## How it works

The mechanism is host-orchestrated with container-side detection:

1. **Detection (container).** The agent-runner classifies provider stream
   events (`container/agent-runner/src/limit-detect.ts`):
   - `rate_limit_event` with status `rejected` → `quota`
   - a streak of ≥6 consecutive `api_retry` events (or >5 minutes with no
     progress) → `overload`
   - an error result matching billing text (`billing`, `credit balance`,
     `insufficient credit`, `payment`) → `billing`

   On a hit, `processQuery` throws `ProviderLimitError`; the poll loop writes
   a `fallback_report` system action to `outbound.db`, leaves the claimed
   messages in `processing`, and drains until the host kills the container.

2. **Switch (host).** `handleFallbackReport` (`src/modules/fallback/controller.ts`)
   enters fallback: persists the state in the `fallback_state` table (single
   row, id=1), re-presents the stuck messages (back to `pending`, no `tries`
   bump), writes a degradation fragment into every group's `.claude-fragments/`,
   queues a switch notice for the origin conversation, and restarts all
   containers. On respawn, `applyProviderOverride` (`src/provider-override.ts`)
   substitutes the backup provider for the native one.

3. **Return (host sweep).** Every 60s, `sweepFallbackReturn` drives a probe
   state machine: when the retry time arrives, the origin session is restarted
   on the native provider for one turn. A clean turn exits fallback everywhere;
   a failed or timed-out probe re-schedules with backoff (5, 10, 20, 40, 60
   minutes).

4. **Safety net (host sweep).** `sweepFallbackSession` enforces a response
   guarantee: any trigger message stuck `pending`/`processing` for more than
   10 minutes forces fallback entry even if the container never reported —
   covering wedged or crashed containers.

## Configuration

Set in `.env`:

```bash
# Local backup (ships with this module):
FALLBACK_PROVIDER=ollama
OLLAMA_MODEL=qwen3:14b          # required for ollama
OLLAMA_BASE_URL=http://host.docker.internal:11434   # optional, this is the default

# Or a cloud backup through OpenCode (requires /add-opencode):
# FALLBACK_PROVIDER=opencode
# OPENCODE_MODEL=openrouter/deepseek/deepseek-v4-pro   # any model OpenCode can route
```

With no `FALLBACK_PROVIDER` configured, limit events produce an owner notice
explaining that no backup is available; nothing else changes.

The `opencode` backup works with any provider OpenCode itself supports —
OpenRouter, OpenAI, Google, DeepSeek, a direct provider API key, etc. — the
`OPENCODE_MODEL` value is just OpenCode's `provider/model` reference, and
credentials follow the normal OpenCode configuration (OneCLI vault / env).
No OpenRouter account is required if you point OpenCode at a provider
directly.

The `ollama` provider ships with this module (`src/providers/ollama.ts`,
`container/agent-runner/src/providers/ollama.ts`): Ollama speaks the Anthropic
API natively, so the provider is the Claude provider pointed at the local
endpoint via `ANTHROPIC_BASE_URL`. A local model keeps the fallback path
working even when the outage is network- or billing-wide.

## Operator surface

- **Chat (owner-only):** `/fallback` or `/fallback status`, `/fallback force`,
  `/fallback return`. Handled entirely host-side (`src/modules/fallback/commands.ts`)
  so they work while the native provider is down.
- **CLI:** `ncl fallback status|force|return` (`src/modules/fallback/cli.ts`).
- **Notices:** the owner gets a message on switch, on return, and on
  double-fault (backup also failing). The switch notice for the origin
  conversation is prepended to the first real response (`fallback_pending_notices`
  table) rather than sent as a standalone message.
- **Audit:** every transition is logged to the `fallback_events` table.

## Context continuity

On switch, the module builds a short summary of the recent conversation
(`src/modules/fallback/summary.ts`) and delivers it to the backup provider as
an on-wake briefing, so the first fallback turn doesn't start blind. A
degradation fragment (`.claude-fragments/zz-fallback.md`) tells the agent it
is running on the backup model and to answer identity questions truthfully.

## State

- `fallback_state` (central DB, single row): active flag, mode (auto/forced),
  classification, backup provider/model, probe bookkeeping, retry schedule.
- `fallback_events` (central DB): append-only transition log.
- `fallback_pending_notices` (per-session `inbound.db`): switch notice awaiting
  prepend-on-delivery.

## Testing

- Unit: `src/modules/fallback/*.test.ts` (state machine, decision logic,
  notices, commands, override), `container/agent-runner/src/limit-detect.test.ts`.
- Integration: `container/agent-runner/src/integration.test.ts` (poll-loop
  limit paths), `container/agent-runner/src/providers/mock.test.ts`.
- End-to-end: the mock provider simulates limits via `MOCK_PROVIDER_FAIL=quota|billing|overload`
  and `MOCK_RESET_AT` (unix seconds), forwarded to containers only when
  `NODE_ENV !== 'production'`.
