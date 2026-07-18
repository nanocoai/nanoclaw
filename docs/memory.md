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
