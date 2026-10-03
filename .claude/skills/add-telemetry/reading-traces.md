# Reading the traces

Referenced from SKILL.md. Read this when querying the traces the skill exports,
not when installing it. Everything here describes the `nanoclaw.*` attributes
and the span shapes as they are emitted today; where a behavior belongs to a
specific collector it is labelled as such.

## Two vocabularies

Every span carries both OpenInference (what Phoenix indexes) and OTel's GenAI
semantic conventions. Moving to another collector is a change of `endpoint`,
plus `headers` if it wants auth — no reinstrumentation. Every `agent.turn`,
continuations and later segments included, carries
`gen_ai.operation.name = invoke_agent` and `gen_ai.agent.name = <group>`;
`llm.call` is emitted with OTel `SpanKind.CLIENT`, everything else `INTERNAL`.

**Do not "simplify" by dropping one vocabulary.** Phoenix translates GenAI into
OpenInference on ingest, which makes most of the OpenInference set look
redundant — except the cache breakdown, which only arrives through
`llm.token_count.prompt_details.cache_read` / `cache_write`. Emitted under the
GenAI names alone, Phoenix stores the cache counts as inert attributes and
prices every token as fresh input, overstating cost on agents that spend on
re-read context. ([Upstream gap, still
open](https://github.com/Arize-ai/openinference/issues/2616).)

## Token counts, by span

`llm.call` carries the input side under the vendor names. The turn's totals
live under `nanoclaw.turn_tokens_*`, and no output count is published anywhere.
Both are deliberate:

- **A turn is not a generation.** Phoenix prices only spans of kind LLM, and a
  turn is AGENT — but other backends (Langfuse, for one) bill a turn carrying
  `llm.token_count.*` *on top of* the same turn's children, charging one
  consumption twice. Under `nanoclaw.*` the numbers stay queryable and no cost
  engine reaches them. The turn's model name is `nanoclaw.model` for the same
  reason: a model name is what a cost engine needs to pick a tokenizer, so as
  `llm.model_name` it invites the backend to tokenize the turn's own
  `input.value` / `output.value` and bill it anyway. `llm.call` keeps
  `llm.model_name`, where it is correct.
- **`usage.output_tokens` on an assistant message is a partial streaming
  value**, not the call's output. It ships as `nanoclaw.output_tokens_partial`.
  Reading the *last* message instead does not fix it — the call-grouping
  identity includes `output_tokens`, so a real count would open a span of its
  own. The authoritative per-call number needs `includePartialMessages` and the
  `message_delta` stream event; until then the turn's `result` is the only true
  output total.

## Phoenix specifics

Only two attributes are Phoenix-specific: `openinference.span.kind` (consumed
into the `span_kind` column) and `openinference.project.name` (project routing;
elsewhere `service.name` serves, already set to `nanoclaw-agent`). A collector
that knows neither stores them as ordinary attributes, and `nanoclaw.cost_usd`
still holds because the module computes it from the SDK's own number rather
than any collector's pricing engine.

### One project, not one per group

Phoenix assigns a trace to a project by its **root span**, ignoring each span's
own resource. Any agent-to-agent delegation therefore lands the delegated
agent's spans in the *caller's* project, and the delegated agent's own project
looks empty — per-group projects stop meaning anything the moment agents talk
to each other.

So: give every group's `otel.json` the **same** `projectName`, and filter per
agent inside the project with the `nanoclaw.group_name` span attribute (see
below). The resource carries the same key, but the Phoenix span API does not
expose resource attributes — the span-level stamp is what makes the filter
possible.

**Filter syntax trap.** Phoenix accepts both forms in
`validateSpanFilterCondition`, but only the bare dotted path matches anything:

```
nanoclaw.group_name == '<group>'                 → matches
attributes['nanoclaw.group_name'] == '<group>'   → validates OK, matches NOTHING
```

## Group attributes on every span

A `SpanProcessor.onStart` stamps `nanoclaw.group_name`,
`nanoclaw.agent_group_id`, `nanoclaw.provider` and `nanoclaw.effort` on every
span, so any query can be scoped to a group without a join.

**`nanoclaw.effort` records intent, not confirmation.** It is the reasoning
effort *requested* of the provider, read from `container.json`. The model is
echoed back by the SDK, so `llm.model_name` on an `llm.call` (and
`nanoclaw.model` on the turn) names what actually ran; nothing echoes effort.
It is always written, `'default'` included, so "left at the SDK default" is
groupable rather than indistinguishable from an absent attribute.

## Segments and crash resilience

Two mechanisms bound span loss when a container dies badly:

- **JS crashes** (`uncaughtException` / `unhandledRejection`): handlers close
  every open span with ERROR status, drain the exporter (4s cap) and exit 1.
  The crash is never swallowed — the handler owns the stderr report. The same
  handlers cover SIGTERM/SIGINT, and they call `process.exit` only when they
  are the sole listener for that event: if the runner ever registers a graceful
  shutdown of its own, telemetry drains and steps aside instead of racing it.
- **Native crashes** (e.g. SIGTRAP — no JS runs): a 60s checkpoint ends and
  reopens long-lived spans (turn, tool, subagent) that have been open for over
  2 minutes, as **sibling segments** under the same parent. Segment 1 exports
  early and all later children anchor to it, so a native death orphans at most
  the current open segment.

Reading segmented spans: intermediate segments carry `nanoclaw.segment` and
`nanoclaw.segment_continues: true`; the **final** segment has no
`segment_continues` and is the one carrying counters, cost, output and status.
Dashboards that count turns must filter on the absence of `segment_continues`.
Spans shorter than 2 minutes never segment.

A reopened segment is rebuilt from the attributes the turn was born with, plus
`session.id` / `prompt.id` once the turn has learned them — the SDK reveals
those only on the first tool hook, so a turn that never runs a tool carries
neither, on any segment. Filtering on their absence selects tool-less turns,
not broken spans.

**In a generic trace UI.** Children born after a checkpoint still parent to
segment 1, which has already ended. A UI that assumes a child lies inside its
parent's time range draws those children outside the parent's bar; Jaeger, for
one, also logs a clock-skew warning per span. Expected, and valid under the
OTel spec — a span context stays usable for parenting after `end()`. Phoenix
draws the tree without complaint.

**Point spans.** `task.completed|failed|stopped` and `agent.compact` are
backdated with the duration the SDK reports, so they cover their real window;
`delivery.send` covers the outbound write, so its duration is delivery latency.
`delivery.dropped`, `runner.error`, `provider.blocked` and `permission.denied`
are instants.

## Cost and API time

`nanoclaw.cost_usd` is **this turn's** cost, exact on every turn: the first turn
of a `query()` pays the process total in full and each later exchange pays the
difference. `nanoclaw.session_cost_usd` is the SDK's raw running total, kept
because it is what the SDK actually asserts. `nanoclaw.cost_cursor_reset=true`
marks a total that dropped with no `query()` in between — it should not happen;
the turn then pays the new total and the flag makes the anomaly a query.

`nanoclaw.duration_api_ms` follows the identical rule, because
`result.duration_api_ms` is also a running total of the process. It is **this
turn's** API time, with `nanoclaw.session_duration_api_ms` holding the raw
total and `nanoclaw.api_cursor_reset=true` marking a drop with no `query()` in
between. On any single turn it is at most `nanoclaw.turn_duration_ms`, since
API time is a component of the turn's wall clock.

## Skill and MCP usage

Every tool span carries what KIND of call it was, so grouping needs no string
parsing:

| Attribute | Where |
|---|---|
| `nanoclaw.tool_kind` | Every tool span: `mcp`, `skill` or `builtin`. Never absent. |
| `nanoclaw.mcp_server` / `nanoclaw.mcp_tool` | MCP spans: `nanoclaw` / `send_message`, split out of the `mcp__<server>__<tool>` name. |
| `nanoclaw.skill` | `tool.Skill` spans, from the call's `skill` argument. |
| `nanoclaw.tool_names` / `nanoclaw.tool_call_count` | `llm.call` spans, only when the call chose at least one tool: the names, comma-joined, and how many. Parallel calls read as one decision with N tools. |
| `nanoclaw.tool_calls` | Every turn, zero included. An integer, and only ever an integer. |
| `nanoclaw.skills_used` / `nanoclaw.mcp_servers_used` | The turn's distinct skills / servers, sorted, comma-joined. Written only when non-empty. |

Read the absences the same way everywhere in this module: a turn with
`tool_calls` and no `skills_used` used no skill; a turn with no `tool_calls` at
all asserts nothing. Filter precisely on the child spans
(`nanoclaw.skill == 'x'`); the turn lists are for scanning and coarse filtering.

The span NAME of a skill call stays `tool.Skill` — the skill goes in the
attribute. Putting it in the name would read better in one waterfall and
fragment `GROUP BY name`, which is what Phoenix aggregates latency from.

One edge: the MCP split is lazy on the server segment, so a server whose
sanitized name itself contains `__` splits in the wrong place. The tool name
alone cannot disambiguate it.

## Diagnostics by symptom

**The turn closed OK and the user got nothing.** Start at the turn's
`nanoclaw.delivered_count`:

- `0` **with** a `delivery.dropped` child — the agent produced text but never
  wrapped it in `<message to="...">`, so there was nothing to deliver. An agent
  behavior problem; look at the prompt or the standing instructions.
- `0` **with no** `delivery.dropped` — the turn never reached any delivery path.
  Look for a `runner.error` span in the same trace; `nanoclaw.stage` names which
  leg failed.
- `> 0` — a delivery happened. The loss is downstream of the container, so check
  the host: `logs/nanoclaw.error.log` and the `messages_out` row itself.
- `0` **with `nanoclaw.output_internal_only=true`** — the agent wrote only
  `<internal>` scratchpad and chose to stay silent. The poll loop blanks that
  text before deciding whether to nudge, so there is no `dropped` either.
  Behaviour, not loss.

`delivered_count` counts **both** delivery paths, which is why it is the right
thing to read first. Agents reach the user two ways: `<message to="...">`
blocks, which the poll loop writes and which produce `delivery.send` spans; and
the `send_message` / `send_file` / `send_card` MCP tools, which write from the
separate MCP process and produce only their own `tool.mcp__nanoclaw__*` spans.
A turn that answered entirely through the MCP tools has `delivered_count > 0`
and **no `delivery.send` at all** — healthy, not a gap.

A `delivery.send` with `nanoclaw.thread_resolved=false` is worth noticing on its
own: the message was delivered, but to the channel's top level rather than the
intended thread, because `resolveDestinationThread` fell through. The span's
duration is the outbound write itself — a slow one points at the session DB, not
at the model.

**The turn was fast and the user still complained it took forever.**
`turn_duration_ms` only covers `query()` → `result`; the message may have sat in
`inbound.db` long before that. Read `nanoclaw.inbound_wait_ms` on the turn, then
split by `nanoclaw.runner_uptime_ms` on the same span:

- **wait high, uptime low** — the message waited for the container to *start*.
  The cost is spawn, not queueing. Expected for the first message to an idle
  group; a concern only if it repeats on a group that should stay warm.
- **wait high, uptime high** — the container was already up, so the delay is
  host-side: the 60s sweep in `src/host-sweep.ts`, the poll interval, or a host
  that was down. Scheduled `kind='task'` messages wait on the sweep by design.
- **`nanoclaw.inbound_clock_skew=true`** — **not latency.** The host wrote the
  enqueue time and the container read the claim time, and the two clocks
  disagree (Docker Desktop's VM clock can drift after the host sleeps). The
  reported wait was clamped to `0` and the real value is unknown; discard it.
  `runner_lag_ms` comes from a single clock, so it stays trustworthy and is the
  control.

`inbound_wait_ms` is **absent**, not `0`, when the turn claimed no message — an
`on_wake` wake, or a continuation the SDK resumed on its own. Absent means
"nothing to measure"; `0` would claim there was no wait. This is the opposite
convention from `delivered_count` above, where the zero *is* the finding.

`nanoclaw.continuation_anchor` says where a continuation's span starts: `signal`
(the first main-thread signal before the model's reply — thinking, a retry, a
compaction), `assistant` (no such signal arrived, so the first assistant message)
or `stale_signal` (a signal arrived, but so long before the reply that it was
discarded and the assistant message used instead).

Continuation exchanges measure the wait as `turn start − due` rather than
`claim − due` (the poll loop completes the row on the same tick it pushes the
message, so the claim is never observable), which reads slightly high by the
push→first-signal gap. They carry no `runner_lag_ms`, since its analogue there
would be the turn's own duration. A continuation whose origin lookup finds
nothing reports no wait.

**The agents spent an hour repeating the same error.** Look for a
`provider.blocked` span before the burst. A quota block is the *cause* and the
`context_overflow` flood that follows is the *symptom* — retries keep growing
the context until it bursts, so reading the overflow count alone points at the
wrong thing. Read `nanoclaw.classification` on the span:

- `quota` — out of credits. It does **not** clear on its own; `resets_at` is
  absent because there is nothing to wait for. Someone has to fix billing.
- `rate_limit` — a window limit. `resets_at` (when present) is when it reopens;
  retrying before that is guaranteed to fail.

`resets_at` is only stamped when the message carries an ISO timestamp, which is
the format `classifyRateLimitEvent` produces. The CLI's own wording
(`resets <hh:mm> (<tz>)`) is a local time with **no date**, so the class is
recorded and the timestamp deliberately is not — an absent attribute beats a
guessed one.

**Failure kinds.** `nanoclaw.failure_kind` is derived from what already
arrives (exit code, error text, interrupt), so grouping failures never means
reading strings. The classes, in the order they are tested:

| Kind | Meaning |
|---|---|
| `interrupted` | The turn was interrupted. |
| `approval_pending` | A tool returned `error (approval-pending): …`. Carries a **neutral** status, on purpose: the class stays queryable (`GROUP BY failure_kind` counts how often the system blocks on a human) without inflating the error rate, and the containing turn inherits no error for an approval flow working as designed. |
| `output_too_large` | A single tool result larger than the harness accepts (`Read` past its token cap). The context itself is fine. |
| `killed` | Exit 137 — a process killed from outside, typically the OOM killer. |
| `tool_not_found` | Exit 127, `command not found`, `is not installed`, `ModuleNotFoundError`: a dependency absent from the image. |
| `timeout` | The tool or call timed out. |
| `quota` | Out of credits or a billing block (a `403 billing_error` lands here, not in `permission`). |
| `rate_limit` | A usage or session limit, bare `429`s included. |
| `permission` | Denied, forbidden, unauthorized. |
| `api_error` | Strictly the server failing (`overloaded`, 5xx). |
| `context_overflow` | The context window burst. |
| `model_refusal` | The model declined. |
| `other` | An honest unknown, so an emerging pattern is not forced into an existing label. |

**`origin_lookup` missing on a turn is not a gap.** It is written only for
continuation exchanges, because it reports the outcome of a lookup that only
happens there — a turn opened by `turnStart` takes its origin from the prompt
and has nothing to look up.

**A continuation's `trigger` has four values, and a miss is always labelled.**
`message` and `task` come from the inbound row the lookup found. When it finds
nothing the exchange still had a cause: `nudge` — the previous turn ended in
`delivery.dropped`, the poll loop pushed its wrap-nudge, and this exchange is
the model answering the *runner*; `background` — the SDK resumed with no
message at all (a Monitor event, a background task settling). `GROUP BY trigger`
on `cost_usd` is how you see what nudging costs. The lookup window opens at the
previous turn's *start*, so a message that arrived mid-turn is a hit, not a
`background`.

**A continuation's span looks shorter than its `turn_duration_ms`.** The span
opens at the first SDK signal of the exchange, and where the SDK emits nothing
before the first assistant message the model latency falls outside it. For
duration analysis read `nanoclaw.turn_duration_ms`, which is measured; the span
duration is a floor.

**An `llm.call` duration looks too large.** It is INFERENCE, not measurement:
the SDK never says when the model started producing a message, so the span
covers the interval between the previous known activity and the message
arriving. On the main thread a tool that ran in between advances that boundary,
so tool time is not charged to the model. On the **worker** path it is: a
worker's `llm.call` keys its boundary by `parent_tool_use_id` while a worker's
tools key theirs by `agent_id`, and the SDK exposes no link between the two, so
a worker's "model time" includes its own tools. For turn-level latency use
`nanoclaw.turn_duration_ms`, which is measured rather than inferred.

**Two agents that talk to each other appear as separate traces.** The trace
context rides inside the message content. Confirm the sender stamped it:

```bash
pnpm exec tsx scripts/q.ts data/v2-sessions/<group>/<session>/inbound.db \
  "SELECT content FROM messages_in ORDER BY timestamp DESC LIMIT 1"
```

should show a `traceparent` key.

## Beyond traces

Traces answer *what happened* and *what it cost*, never *whether the answer
was good* — `result_subtype = success` means the loop terminated cleanly.
Closing that gap takes evaluation, not more instrumentation: Phoenix supports
span annotations, and human labels are the input a judge has to be calibrated
against.
