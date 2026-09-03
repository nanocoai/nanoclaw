# Agent Memory

Every agent group has persistent, file-based memory: plain Markdown files that
survive container restarts, session ends, compaction, and provider switches.
There is no database and no embedding store. The agent reads and edits the
files with ordinary file tools, and you can too.

On the host the files live in `groups/<folder>/memory/`. Inside the container
the same directory is mounted at `/workspace/agent/memory/`.

## Layout

```
memory/
├── index.md              # top-level index + Core Memory (always loaded)
└── system/
    ├── index.md          # index for the system folder
    └── definition.md     # how the memory behaves (always loaded)
```

The scaffold is created automatically when a container boots. It only writes
what is missing, so the agent's own edits and accumulated memory are never
overwritten.

Two files are always loaded:

- **`index.md`** holds the Core Memory section (the few durable facts relevant
  in nearly every conversation) and a map of everything else. Headlines and
  pointers only; detail belongs in linked files.
- **`system/definition.md`** tells the agent how its memory works: what to
  store, where to put it, and how to keep it true. It belongs to the agent and
  the agent may improve it over time.

`system/index.md` is a normal folder index and is not injected separately.

Folder layout and Markdown content are flexible, but every durable concept file
still follows the OKF frontmatter rules below. The agent chooses folders based
on which related information will be easiest to find together; a folder may
contain different concept types. Before writing into a new folder, the agent
creates it and its `index.md`.

## How memory reaches the agent

Whenever the provider creates a fresh context window (at startup, after a
clear, and after compaction), a session-start hook injects `index.md` and
`system/definition.md` into the agent's context. Resuming an existing session
injects nothing, because that context already has them.

The hook lives in the agent-runner and is registered with whatever provider
the group runs, so every provider gets the same behavior. For Claude it is
wired through the Agent SDK; other providers wire it through their own
session-start mechanism.

Only those two files are injected, and each is capped at 16k characters (a
truncation notice tells the agent to slim the file). For anything deeper, the
agent follows links from the index and reads the files directly. This keeps
the always-loaded footprint small no matter how large memory grows.

## Portable format (OKF)

`memory/` is an Open Knowledge Format (OKF) v0.1 bundle: one Markdown
concept per file, with YAML frontmatter declaring a
`type` (for example `person`, `project`, `decision`; `index.md` and `log.md`
are exempt). Types are the agent's vocabulary, not a fixed list.

The format is a convention, not a gate. A file with missing or malformed
frontmatter still works as memory; the agent repairs metadata when it next
touches the file. The payoff is portability: any OKF-aware agent or tool can
read the bundle, and switching a group to a different provider carries memory
over untouched (see [provider-migration.md](provider-migration.md)).

## What goes where

| Kind of information | Home |
|---------------------|------|
| Durable facts, people, projects, decisions | `memory/` |
| Role, persona, standing behavior instructions | `/workspace/agent/instructions.prepend.md` |
| Past session transcripts | `conversations/` in the workspace |

## Migrating older memory

Groups created before the shared memory tree may still have legacy storage:
`.seed.md`, memory notes inside `CLAUDE.md` or `CLAUDE.local.md`, Claude's
auto-memory directory, or an `imported-agent-memory.md` from an earlier provider
switch. Run `/migrate-memory` to move standing role and persona into
`instructions.prepend.md` and organize durable facts in the shared memory tree.
Older groups may already contain folders named `memories` or `data`. Those are
still valid agent-chosen folders: normal startup neither creates nor deletes
them, and migration preserves their contents.

## Periodic maintenance

One scheduled series keeps the tree honest, driving the `memory-hygiene`
container skill: `memory hygiene`, **Sundays 08:00**, which audits indexes, OKF
frontmatter, links, contradictions and stale dates, then repairs what is safe.
A new agent gets it at its first conversation — the same message that makes it
introduce itself — **created paused**; existing agents are left alone (no
backfill).

One series is deliberate. Two passes that overlap are two containers rewriting
the same bind-mounted tree with nothing serializing them, so the weekly pass is
the whole schedule.

A pass deletes a fact only when it is clearly obsolete **and** already safely
represented elsewhere; uncertain history stays.

```bash
ncl tasks list --group <id>                 # the series, paused
ncl tasks run <series-id> --group <id>      # try one NOW, schedule untouched
ncl tasks resume <series-id> --group <id>   # enable
ncl tasks pause <series-id> --group <id>    # stop; delete removes it for good
```

Cron runs in the group's effective timezone. `process_after` is set at seeding
time to the **next** Sunday 08:00, and `resume` only flips the row to pending —
it does not move that time. So resuming a freshly seeded series schedules the
first pass for that next Sunday, not for right now; use `ncl tasks run` to get a
confirming pass immediately and read its report. (A series left paused past its
stored time does fire within a minute of resuming — the sweep sees an already-due
row. Time spent paused queues no catch-up runs either way.)

Each pass appends detail to `memory/log.md` and one line to the run log
(`ncl tasks get <series-id> --group <id>`). It messages no one unless the prompt
carries a `<message to="<destination>">` block — append one sentence naming the
destination to add that.

### Adding the series manually

Two kinds of agent do not get the series automatically and need this:

- **Existing agents.** Seeding fires at a group's first conversation, and there
  is no backfill.
- **Agents whose first session was ambient.** Seeding rides the router's
  session-created hook, which by design fires only when an *engaged* message
  creates the session (`src/router-session-created.test.ts` asserts this). A
  wiring with `ignored_message_policy: accumulate` creates its session on the
  first non-engaging message, so the hook never sees a birth — by the time
  someone addresses the agent, the session already exists. If you wire an agent
  into a channel that already has traffic and accumulates ambient context,
  assume you need the command below. `ncl tasks list --group <id>` tells you.

Add it with plain `ncl tasks create`:

```bash
ncl tasks create --group <id> \
  --name "memory hygiene" \
  --recurrence "0 8 * * 0" \
  --prompt 'Run the memory-hygiene skill over /workspace/agent/memory. Delete a fact only when it is clearly obsolete AND already safely represented elsewhere; keep uncertain history. Finish with one short line: what changed, or "no changes".'
```

The prompt only has to invoke the skill — `container/skills/memory-hygiene/`
carries the procedure, and every group mounts it. (A group whose `skills` list
was narrowed by hand is the exception; re-enable `memory-hygiene` there first.)

`create` has no `--status`, so the series lands `pending`. That is safe — with
`--recurrence` its first run is the coming Sunday, not now — but pause it if you
want it to match a seeded group exactly:

```bash
ncl tasks pause <series-id> --group <id>
```

Seeding is stamped per group under
`data/v2-sessions/<agent-group-id>/.memory-maintenance-tasks`, so a series you
delete stays deleted.

## Operator notes

- You can read or edit any memory file directly on the host under
  `groups/<folder>/memory/`; changes are picked up the next time a context
  window is created.
- Wrong or stale facts are just text: delete or correct them in place, or ask
  the agent to (it is instructed to prune and update on correction).
- The default templates live at
  `container/agent-runner/src/memory/templates/`, mirroring the generated
  memory tree. NanoClaw copies a template only when that memory file is missing.
  It never overwrites an existing memory file.
