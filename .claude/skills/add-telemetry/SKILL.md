---
name: add-telemetry
description: Add OpenTelemetry tracing to NanoClaw agent containers. Exports turns, model calls, tools, subagents, compaction and background tasks as spans to any OTLP collector, carrying cost, tokens with cache breakdown, reasoning volume, failure class, and which skills and MCP servers each turn used. Per-group opt-in via otel.json.
---

# Add OpenTelemetry tracing

Exports agent traces to **any OTLP collector**. Turns, model calls, tools,
subagents, compaction and background tasks become spans, carrying cost, tokens
with the cache breakdown, reasoning volume, failure class, turn origin, and which
skills and MCP servers each turn went through. [Arize
Phoenix](https://phoenix.arize.com/) is the reference target, but the transport
is plain OTLP/HTTP and the endpoint is one line of config.

**Off by default.** Nothing runs, and the OpenTelemetry packages are never even
imported, unless a group has an `otel.json` in its folder. That file is install
state upstream does not version, so switching it on or off never conflicts on
update.

## Apply

### 1. Copy the module, its state file and the tests

```bash
cp .claude/skills/add-telemetry/files/telemetry.ts container/agent-runner/src/telemetry.ts
cp .claude/skills/add-telemetry/files/telemetry-state.ts container/agent-runner/src/telemetry-state.ts
cp .claude/skills/add-telemetry/files/telemetry.test.ts container/agent-runner/src/telemetry.test.ts
cp .claude/skills/add-telemetry/files/telemetry-integration.test.ts container/agent-runner/src/telemetry-integration.test.ts
```

`telemetry.ts` holds all the logic, so every reach-in below is a single call.
`telemetry-state.ts` holds only the session state that crosses into the MCP
process. The invariants of both are documented at their own definitions; read
them there before editing either.

### 2. Install the OpenTelemetry packages

The agent runner is a **Bun** tree, not a pnpm workspace — `pnpm install` there
corrupts it. Add these to `container/agent-runner/package.json` under
`dependencies`, pinned exactly:

```json
"@opentelemetry/api": "1.9.0",
"@opentelemetry/exporter-trace-otlp-proto": "0.208.0",
"@opentelemetry/resources": "2.4.0",
"@opentelemetry/sdk-trace-base": "2.4.0"
```

Then install and commit the updated `bun.lock`. Bun is not on the host, so run it
inside the agent image:

```bash
docker run --rm -v "$PWD/container/agent-runner:/w" -w /w \
  --entrypoint bun "$(docker images --format '{{.Repository}}:{{.Tag}}' | grep 'nanoclaw-agent' | grep ':latest' | head -1)" install
```

No `minimumReleaseAge` policy applies to this tree — check the release dates on
npm and pin deliberately.

Then rebuild the agent image, because its `node_modules` is baked at build time
from this lockfile. Without the rebuild every container logs
`[telemetry] unavailable` and emits nothing:

```bash
./container/build.sh
```

A group pinned to its own `imageTag` needs `ncl groups restart --rebuild --id <agent-group-id>`
instead.

### 3. Wire the provider

All in `container/agent-runner/src/providers/claude.ts`. Each addition is
idempotent — skip any already present.

Add the import next to the other local imports:

```typescript
import * as telemetry from '../telemetry.js';
```

In `preToolUseHook`, before `return { continue: true }`:

```typescript
telemetry.toolStart(input);
```

Give `postToolUseHook` its `input` parameter if it has none — tools are paired by
`tool_use_id`, which only the input carries — and add the call before
`return { continue: true }`:

```typescript
const postToolUseHook: HookCallback = async (input) => {
  // …
  telemetry.toolEnd(input);
```

In `query()`, before `const sdkResult = sdkQuery({`:

```typescript
telemetry.turnStart(input);
```

Inside the inner `options: { … }` object of the `sdkQuery` call, next to
`mcpServers`, spread the thinking option. It returns an empty object unless a
group opts in:

```typescript
...telemetry.thinkingOption(),
```

In the same options object, alongside the other `hooks` entries:

```typescript
SubagentStart: [{ hooks: [telemetry.subagentHook] }],
SubagentStop: [{ hooks: [telemetry.subagentHook] }],
```

And inside `translateEvents`, as the first statement of the `for await` loop over
`sdkResult`, before the `aborted` check — the single call that observes the whole
SDK message stream:

```typescript
telemetry.observe(message);
```

### 4. Wire the outbound message

Two lines in `container/agent-runner/src/mcp-tools/core.ts`: import the helper
and spread it into `sendMessage`'s content.

```typescript
import { traceparentField } from '../telemetry-state.js';
```

```typescript
content: JSON.stringify({ text, ...traceparentField() }),
```

Import `telemetry-state.js` and **never `telemetry.js`**: this file runs in the
MCP server, a separate process (`StdioServerTransport`), and importing the
telemetry module there would start an OTLP exporter and install signal handlers
it must not have. `telemetry-state.js` reaches only the mailbox.

Leave the existing `session-state` import alone — this step adds a line, it does
not modify one.

### 5. Wire the delivery leg and the runner's swallowed errors

All in `container/agent-runner/src/poll-loop.ts`, which is runner-side only.
**Do not instrument `db/messages-out.ts`** instead: it is also imported by
`mcp-tools/*`, which run in the MCP process (step 4). Each addition is
idempotent — skip any already present.

Add the import next to the other local imports:

```typescript
import * as telemetry from './telemetry.js';
```

In `sendToDestination`, wrap the existing `writeMessageOut(...)` call. Both
delivery legs pass through here, so this one site covers both:

```typescript
  const deliveryStartedAt = Date.now();
  let deliveryError: string | undefined;
  try {
    await writeMessageOut({ /* …unchanged… */ });
  } catch (err) {
    deliveryError = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    telemetry.delivery({
      destinationType: dest.type,
      channelType,
      bodyChars: body.length,
      threadResolved: destRouting !== null,
      error: deliveryError,
      startedAt: deliveryStartedAt,
    });
  }
```

Keep the re-throw: a failed write must still fail the turn. `startedAt` gives the
span the write's duration, so it reads as delivery latency.

In `dispatchResultText`, inside the `if (hasUnwrapped) { … }` block, right after
its `log()`. Outside that block the span would fire on every result and mislabel
the next continuation as a nudge:

```typescript
    telemetry.dropped(scratchpad.length);
```

One line in each of four `catch` blocks. Keep whatever the block already does
(the `processQuery` one re-throws). `fatal: true` marks the two failures that
kill the turn; the other two are best-effort helpers that return `false` and
must not inflate the error rate:

| where | line |
|---|---|
| `Query error` catch | `telemetry.runnerError('query', err, { fatal: true });` |
| `processQuery` outer catch | `telemetry.runnerError('turn', err, { fatal: true });` |
| `chatRowWrittenSince` | `telemetry.runnerError('outbound-verify', err);` |
| `wasWrittenInSeqWindow` | `telemetry.runnerError('outbound-verify', err);` |

In `sendToDestination`, spread the trace context into the content it writes —
the poll-loop counterpart of step 4; both legs must carry it, or agent-to-agent
traces only link on one of them:

```typescript
      content: JSON.stringify({ text: body, ...telemetry.traceparentField() }),
```

**This one has a companion change, and skipping it breaks delivery.** The echo
guard in `wasWrittenInSeqWindow` compares the stored row against a rebuilt
`JSON.stringify({ text: body })`; with an extra key in the content that byte
comparison never matches, and duplicate suppression silently stops working. Add
a text extractor next to the guard and change the predicate's last line to call
it — one line inside the upstream function, so a future upstream edit merges
instead of conflicting. Do not restructure the surrounding `.some(predicate)`.

```typescript
function parsedText(content: string): string | undefined {
  try {
    return (JSON.parse(content) as { text?: string }).text;
  } catch {
    return undefined;
  }
}
```
```typescript
        parsedText(message.content) === body,
```

Then delete the line the predicate no longer uses, a few lines above the
`.some(` — the integration test fails if it survives:

```typescript
    const content = JSON.stringify({ text: body });
```

and in the guard's JSDoc replace the whole sentence from "Content equality is
exact: the door writes `JSON.stringify({ text: body })`" through "and
delivers." with "Equality is on the `text` field, so extra keys in the content
do not break the guard." The predicate ends up as:

```typescript
        message.channel_type === channelType &&
        parsedText(message.content) === body,
    );
```

Finally, one line in `handleEvent`, below the existing `log()` in `case 'error'`.
Keep it unconditional: `case 'error'` also fires on every API retry, and the
retry-vs-block filter lives inside `providerBlocked`.

```typescript
      telemetry.providerBlocked(event);
```

### 6. Validate

If you edited any module under `container/agent-runner/src/`, copy it back over
its counterpart in `files/` first. `files/` is what a fresh install receives, and
the installed tree is what the tests run against:

```bash
for f in telemetry.ts telemetry-state.ts telemetry.test.ts telemetry-integration.test.ts; do
  diff -q ".claude/skills/add-telemetry/files/$f" "container/agent-runner/src/$f" \
    || echo "OUT OF SYNC: $f"
done
```

Silence means they match. Any `OUT OF SYNC` line is a release blocker.

Typecheck. It catches a renamed symbol or a moved module, and the type-only
imports at the top of `telemetry.ts` put the four OTel packages under it:

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

Then the tests, in the agent image. Mount `bunfig.toml` as well as `src`: its
`[test] preload` registers the mailbox, and without it every test that touches
session state fails with `No agent mailbox registered`.

```bash
docker run --rm -v "$PWD/container/agent-runner/src:/app/src:ro" \
  -v "$PWD/container/agent-runner/bunfig.toml:/app/bunfig.toml:ro" -w /app \
  --entrypoint bun "$(docker images --format '{{.Repository}}:{{.Tag}}' | grep 'nanoclaw-agent' | grep ':latest' | head -1)" \
  test src/telemetry.test.ts src/telemetry-integration.test.ts
```

`telemetry-integration.test.ts` asserts the placement of every call in the three
files this skill reaches into — including that `runPollLoop` and `processQuery`
report their fatal errors and that `dropped` sits inside the `hasUnwrapped`
branch — and goes red if one is deleted or moved; `telemetry.test.ts` covers the
module's own behavior.

If the typecheck or the integration test names a function this tree no longer
has, the reach-in moved. Find where that responsibility lives now and re-derive
the line there; if it moved into a module the MCP process also imports, drop the
point instead (step 4 explains why).

## Turn it on for a group

Any OTLP/HTTP traces endpoint works — a self-hosted collector, or a managed one
with a bearer token in `headers`. The collector must be reachable from inside the
container. If the user has no preference, offer Phoenix:

> Run a collector if you don't have one. For Phoenix:
> `docker run -d --name nanoclaw-phoenix -p 6006:6006 -v nanoclaw-phoenix-data:/mnt/data --restart unless-stopped arizephoenix/phoenix:latest`
> Then open http://localhost:6006 to see traces arrive.

An OpenTelemetry Collector works just as well: point `endpoint` at it and let it
fan out to as many backends as you like — each one receives the same spans.

Enable per group by writing `otel.json` into that group's folder, then restart
the group so a fresh container picks it up:

```bash
echo '{"endpoint":"http://host.docker.internal:6006/v1/traces"}' > groups/<folder>/otel.json
ncl groups restart --id <agent-group-id>
```

`/app/src` is a live mount, so no image rebuild is needed — but a running
container keeps the module it imported at startup. Restart the instrumented
groups after any change to `telemetry.ts`.

### Options

| Key | Effect |
|---|---|
| `endpoint` | Required. OTLP HTTP traces endpoint. |
| `projectName` | Shorthand for `resourceAttributes['openinference.project.name']`, the Phoenix project. Defaults to `nanoclaw`. **Use ONE shared project across all groups** — see `${CLAUDE_SKILL_DIR}/reading-traces.md`. Ignored by collectors that do not read that attribute. |
| `headers` | Extra HTTP headers, for a collector behind auth. |
| `resourceAttributes` | Extra keys merged into every span's resource, for any collector (`deployment.environment`, a tenant id, another `service.name`). Overrides `service.name` and the project name; never the `nanoclaw.*` identity keys. |
| `thinkingText` | Opt-in to the model's reasoning text. Changes the agent's inference config and records reasoning over the group's real content; leave it off unless you want that. |

## Troubleshooting

**No traces appear.** The container reaches the host through
`host.docker.internal`, not `localhost` — a collector bound to `127.0.0.1` on the
host is unreachable from inside. Check the container's stderr for a
`[telemetry] active` line; its absence means `otel.json` was missing or invalid.

**`[telemetry] unavailable` in the logs.** The OpenTelemetry packages are not in
the image the group runs — groups with their own `imageTag` keep a stale image
until rebuilt. The module degrades to a no-op instead of crash-looping.

**Spans stop at the turn, with no model calls or tools.** The provider wiring is
gone — most likely an upstream merge took it. Re-run this skill; step 6 tells you
which point is missing.

**Spans keep an old shape after editing `telemetry.ts`** while other groups
already emit the new one. That container is older than the edit and still holds
the old module. `docker ps` shows its creation time; restart the group.

## Reading the traces

Attribute vocabulary, cost, segments, the one-project rule for Phoenix, and
diagnostics by symptom live in `${CLAUDE_SKILL_DIR}/reading-traces.md`. Read it
when querying the collector, not when installing.
