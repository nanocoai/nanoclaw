---
name: add-why
description: Adds `why` — a read-only diagnostic that explains what happened to a single message. Use when a message did not arrive, an agent seems not to have replied, or you need to tell "delivered", "failed" and "still in the outbox" apart. Also lists every produced-but-undelivered message.
---

# Add `why` — explain what happened to one message

NanoClaw already records everything needed to answer *"why didn't that arrive?"*:
`messages_out` holds what the agent produced, `delivered` holds what the host got
out to the platform, and `messages_in` + `processing_ack` hold what the container
did with an inbound. Nothing joins them.

That is a consequence of the two-DB design, not an oversight. Single-writer-per-file
is what removes lock contention, and it puts the produced-message row in
`outbound.db` and its delivery outcome in `inbound.db`. So the join cannot be one
SQL statement — it has to happen outside SQLite. Until something does it, these three
states are indistinguishable without opening two databases by hand:

| State | What it looks like in the data |
|---|---|
| Delivered | `messages_out` row + `delivered` row with `status='delivered'` |
| Failed | `messages_out` row + `delivered` row with `status='failed'` |
| **Stuck in the outbox** | `messages_out` row and **no `delivered` row at all** |

The third is the one that costs you an evening, because nothing anywhere says so.

## What it adds

- `scripts/why.ts` — the diagnostic. Read-only; opens both session DBs with
  `readonly: true` and never writes.
- `scripts/why-format.test.ts` — output tests for the two lines an operator reads
  first: the destination address and the content preview. Both are rendered, not
  stored, so the schema guard below cannot see them.
- `src/why-schema.test.ts` — a drift guard. `why` reads the session schemas
  directly, so a column rename would silently change its verdicts. The test builds
  real tables from `INBOUND_SCHEMA` / `OUTBOUND_SCHEMA` and fails if a field it
  reads disappears.

No core files are modified. No barrel imports, no registry entries, no dependencies —
it uses `better-sqlite3`, which the host already installs and verifies.

## Install

1. Copy the three files into place from the skill directory:

   ```bash
   mkdir -p scripts src
   cp "${CLAUDE_SKILL_DIR}/add/scripts/why.ts" scripts/why.ts
   cp "${CLAUDE_SKILL_DIR}/add/scripts/why-format.test.ts" scripts/why-format.test.ts
   cp "${CLAUDE_SKILL_DIR}/add/src/why-schema.test.ts" src/why-schema.test.ts
   ```

2. Verify the tests pass against the current schema:

   ```bash
   pnpm exec vitest run scripts/why-format.test.ts src/why-schema.test.ts
   ```

3. Check it runs:

   ```bash
   pnpm exec tsx scripts/why.ts --help
   ```

Re-running these steps is safe — both are plain copies.

## Usage

Explain one message:

```bash
pnpm exec tsx scripts/why.ts <message-id>
```

```
message 7f3a…
  session   marketing/sess-01J…
  produced  2026-08-03T05:41:12Z  (2h 14m ago), seq 44, kind text
  to        telegram:88214410
  content   Deploy finished — 3 checks green, 1 flaky retried.

  delivery  NO RECORD in delivered

  VERDICT: not delivered, and nothing recorded why.
           The agent produced this message but the host never wrote a
           delivery outcome for it. It is sitting in the outbox.
           Cause: usually the delivery poll not running, no adapter
                  registered for 'telegram', or the host restarting
                  between production and delivery.
```

Ask the fleet-wide version first — usually the more useful question:

```bash
pnpm exec tsx scripts/why.ts --stuck
```

It accepts inbound ids too, so `why <id>` works whether you are holding the id of
something the agent produced or something it received. On an inbound it reports
whether the container ever acknowledged it, and if it is mid-turn, which tool is in
flight and for how long — the difference between a long Bash step and a hung
container.

Exit codes: `0` delivered or processed, `1` not delivered, `2` no record found.

## Troubleshooting

**`no session databases under …/data/v2-sessions`** — run it from the install root;
paths resolve against `process.cwd()`.

**Every message shows as undelivered** — the host is not running, or no adapter is
registered for that channel. Check `logs/nanoclaw.error.log` first.

**`--stuck` lists messages that did arrive** — a `delivered` row was never written
even though the platform accepted the send. That is a real bug worth an issue, and
`why` finding it is the point.
