# Remove OpenTelemetry tracing

Every step is idempotent — safe to re-run, and safe to run partially applied.

Work through the reach-ins **before** deleting the copied files. In the other
order the container stops booting between steps, because three files still
import a `telemetry.js` that is no longer there.

## 1. Turn it off first

Removing the code while a group still has `otel.json` is harmless, but doing this
first means no container is mid-turn with an open span:

```bash
rm -f groups/*/otel.json
```

## 2. Unwire the provider

In `container/agent-runner/src/providers/claude.ts`, delete these lines (skip any
already gone):

```typescript
import * as telemetry from '../telemetry.js';
telemetry.toolStart(input);
telemetry.toolEnd(input);
telemetry.turnStart(input);
telemetry.observe(message);
...telemetry.thinkingOption(),
SubagentStart: [{ hooks: [telemetry.subagentHook] }],
SubagentStop: [{ hooks: [telemetry.subagentHook] }],
```

Then restore `postToolUseHook`'s signature — it takes no argument without this
skill:

```typescript
const postToolUseHook: HookCallback = async () => {
```

## 3. Unwire the outbound message

In `container/agent-runner/src/mcp-tools/core.ts`, delete the import and restore
the content:

```typescript
import { traceparentField } from '../telemetry-state.js';
```

```typescript
content: JSON.stringify({ text }),
```

Leave the `session-state` import alone — `getCurrentInReplyTo` is not this
skill's.

## 4. Unwire the poll loop

`container/agent-runner/src/poll-loop.ts` carries the largest reach-in. Delete
the import and all eight calls — the six below, plus the `traceparentField()`
spread and the `telemetry.delivery({ … })` block inside `sendToDestination`,
which the next paragraph restores:

```typescript
import * as telemetry from './telemetry.js';
telemetry.runnerError('query', err, { fatal: true });
telemetry.runnerError('turn', err, { fatal: true });
telemetry.runnerError('outbound-verify', err);
telemetry.providerBlocked(event);
telemetry.dropped(scratchpad.length);
```

`runnerError('outbound-verify', …)` appears **twice** — in `chatRowWrittenSince`
and in `wasWrittenInSeqWindow`. Delete both.

Then restore `sendToDestination`'s write. The `try`/`catch`/`finally` exists only
so the delivery span knows which destination failed and how long the write took;
delete it together with the `const deliveryStartedAt = Date.now();` line above
it — without the span the bare `await` is the whole function body again:

```typescript
  await writeMessageOut({
    id: generateId(),
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ text: body }),
  });
```

Finally the echo guard, which this skill changed because the trace context made a
byte comparison stop matching. With the trace context gone the comparison is
correct again — delete the `parsedText` helper above `wasWrittenInSeqWindow` and
restore the predicate's last line and the `content` it compares against — this
line goes right after the `const channelType = …` line inside the `try`:

```typescript
    const content = JSON.stringify({ text: body });
```

```typescript
        message.content === content,
```

Restore the guard's JSDoc sentence too, in full:

```
 * door's cross-segment echo guard. Content equality is exact: the door writes
 * `JSON.stringify({ text: body })` after the same trim/sanitize pipeline, so
 * a true door-written duplicate always matches; a body differing by even one
 * character is a different message and delivers.
```

**Do not skip this one.** Leaving `parsedText` behind is harmless; leaving the
guard comparing a field nothing writes any more is not — it would keep matching,
suppressing real deliveries as duplicates.

## 5. Delete the copied files

```bash
rm -f container/agent-runner/src/telemetry.ts \
      container/agent-runner/src/telemetry-state.ts \
      container/agent-runner/src/telemetry.test.ts \
      container/agent-runner/src/telemetry-integration.test.ts
```

## 6. Remove the packages

Delete these four from `dependencies` in `container/agent-runner/package.json`:

```
@opentelemetry/api
@opentelemetry/exporter-trace-otlp-proto
@opentelemetry/resources
@opentelemetry/sdk-trace-base
```

Then refresh the lockfile inside the agent image — never `pnpm` in this tree:

```bash
docker run --rm -v "$PWD/container/agent-runner:/w" -w /w \
  --entrypoint bun "$(docker images --format '{{.Repository}}:{{.Tag}}' | grep 'nanoclaw-agent' | grep ':latest' | head -1)" install
```

Rebuild the image if the packages should leave it too: `./container/build.sh`.

## 7. Validate and restart

Typecheck is the step that catches a missed reach-in: a leftover `telemetry.`
call fails to resolve once the module is gone.

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
docker run --rm -v "$PWD/container/agent-runner/src:/app/src:ro" \
  -v "$PWD/container/agent-runner/bunfig.toml:/app/bunfig.toml:ro" -w /app \
  --entrypoint bun "$(docker images --format '{{.Repository}}:{{.Tag}}' | grep 'nanoclaw-agent' | grep ':latest' | head -1)" test
```

The suite reports one `error` in the image regardless of this skill:
`src/memory/session-hook.wiring.test.ts` reads a host-tree file the mount does
not include. Every test must pass; that error is not yours.

Confirm nothing survives:

```bash
grep -rn "telemetry\.\|telemetry-state\|traceparent" container/agent-runner/src --include="*.ts"
```

Restart the groups so running containers drop the instrumentation:

```bash
for id in $(ncl groups list --json | jq -r '.data[].id'); do ncl groups restart --id "$id"; done
```

## What is not removed

Traces already exported live in the collector, not in this install. To discard
them, clear the Phoenix projects or drop its data volume
(`docker volume rm nanoclaw-phoenix-data`) — that is the collector's data, and
this skill never owned it.
