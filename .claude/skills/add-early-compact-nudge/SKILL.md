---
name: add-early-compact-nudge
description: Push a one-shot system-reminder into the active SDK query when context usage crosses a configurable fraction of the auto-compact ceiling. The agent must acknowledge and reply, so it verbalizes whether to run /compact at a natural pause point or stay on task.
---

# Add Early Compaction Nudge

When the Claude Agent SDK's `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is configured, the SDK will auto-compact history once effective context exceeds the ceiling. Auto-compaction picks an arbitrary point — frequently mid-task — and the resulting summary tends to drop load-bearing details of the work in progress.

This skill installs an opt-in nudge: when effective context (input + cache_read + cache_creation) crosses a configurable ratio of the ceiling (default 75%), a `<system-reminder>` block is pushed into the active SDK query as a synthetic user message. The reminder suggests running `/compact` at a natural pause point and strongly recommends passing an `instructions` argument so load-bearing details survive the boundary. One-shot per compact cycle; resets automatically when the SDK auto-compacts.

The push is deliberate: delivering the nudge as a user message forces the agent to acknowledge it and verbalize whether the current moment is a natural pause point or whether it's mid-task. That surfaces the compaction decision in the conversation rather than letting the agent silently ignore a context note. The latch + post-compact reset keep it to one nudge per cycle.

## Install

This is a branch-based feature skill. The code lives on `skill/early-compact-nudge`.

### Pre-flight (idempotent)

Skip to **Configure** if all of these are already in place:

- `container/agent-runner/src/compact-nudge.ts` exists
- `container/agent-runner/src/poll-loop.ts` imports from `./compact-nudge.js`
- `container/agent-runner/src/providers/types.ts` has `usage` and `compact_boundary` in the `ProviderEvent` union

Otherwise continue.

### 1. Fetch the skill branch

```bash
git fetch origin skill/early-compact-nudge
```

### 2. Merge

```bash
git merge --no-ff origin/skill/early-compact-nudge -m "Install /add-early-compact-nudge"
```

If a customized fork has touched `poll-loop.ts`, `providers/types.ts`, or `providers/claude.ts`, resolve conflicts by hand. The changes are small (added imports, a new event type, two new event handlers) and isolated to those three files.

### 3. Rebuild the container image

```bash
./container/build.sh
```

### 4. Restart any running containers so they pick up the new code

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

## Configure

Two environment variables, both optional. Both must be set on the host (they're forwarded into the container via the existing env-pass-through).

| Variable | Default | Effect |
|----------|---------|--------|
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `165000` | The SDK's auto-compact ceiling. Already read by the Claude Agent SDK itself; the nudge reads the same value so it stays in sync. |
| `COMPACT_NUDGE_RATIO` | `0.75` | Fraction of the ceiling that arms the nudge. Set to `0` or `>= 1` to disable the nudge entirely. |

Example: a 200k ceiling with a 70% trigger:

```bash
# In your host shell rc, .envrc, or service unit
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000
export COMPACT_NUDGE_RATIO=0.7
```

To disable without uninstalling:

```bash
export COMPACT_NUDGE_RATIO=0
```

## How it works

1. The Claude provider emits a `usage` event after every assistant turn, carrying `input_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` from the SDK.
2. The poll loop's nudge tracker sums those into effective context. If it crosses `ceiling * ratio` for the first time in the current compact cycle, the tracker returns the reminder text from `onUsage()`.
3. The poll loop pushes that text into the active SDK query via `query.push(text)`. The SDK delivers it as a synthetic user message in the same turn — the agent acknowledges it and decides aloud whether to `/compact` or stay on task.
4. When the SDK auto-compacts, the Claude provider emits a `compact_boundary` event. The tracker resets, ready to arm again if usage climbs back over the threshold.

State machine and reminder text live in `container/agent-runner/src/compact-nudge.ts`. Unit tests in `compact-nudge.test.ts` cover threshold arming, one-shot semantics, and post-compact re-arming. Integration tests in `integration.test.ts` cover the push wiring through the poll loop.

## Verify

After install, the next time context approaches the ceiling you should see this in container logs:

```
[poll-loop] Pushing early-compaction nudge into active query
```

In the next assistant message you will see the agent acknowledge the reminder and either invoke `/compact` (typically with an `instructions` payload) or explicitly say it's mid-task and will compact at the next pause.

## Uninstall

```bash
git revert -m 1 <merge-commit-sha>
./container/build.sh
```

Or set `COMPACT_NUDGE_RATIO=0` to disable without removing the code.
