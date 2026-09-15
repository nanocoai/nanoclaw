# Code mode

Code mode runs Claude Code in a persistent tmux session inside an agent
container. The workspace survives container restarts. Detaching a terminal
leaves the agent running; attaching to a cold sandbox starts its container.

A **sandbox** is a code-mode agent group: a durable workspace under
`groups/<name>/` and a disposable session container that wakes on attach
and retires on an idle lease.

## Local terminal

Rebuild the agent image after updating (it needs `tmux`), then start the
Host normally. From the Host checkout:

```sh
bin/ncl sandboxes new my-project
bin/ncl sandboxes list
bin/ncl sandboxes attach my-project
```

Detach with **Ctrl-b, then d**. `new` lands you attached; `--no-attach`
creates without handing the terminal over. An existing group can switch to
code mode with `bin/ncl groups config update --id <group> --code-mode true`,
followed by `bin/ncl groups restart --id <group>`; `bin/ncl groups attach
<group>` is the same terminal as sandbox attachment. All of these verbs are
host-only: an agent cannot invoke them through its mailbox.

`sandboxes new` is the one path that also mints the coding session and, when
a chat platform offers one, binds a surface to it; a group that entered code
mode another way (a template with `codeMode: true`, or `groups config update
--code-mode true`) shows in `sandboxes list` with no session and no surface
until its first attach creates the session, and never gets a surface unless
it is wired by hand.

`list` shows `running` while a session container exists and `cold` once the
idle lease retired it; the workspace is durable and the next attach wakes
it again. The lease keeps a container up for 30 minutes after its last
activity with nobody attached, and for a day with a terminal attached but
silent; a running turn always counts as activity. When the lease expires an
attached terminal is detached cleanly with a notice.

Three more verbs read and steer the session from the terminal:

```sh
bin/ncl sandboxes status my-project   # active | processing | suspended, the last turn stamp
bin/ncl sandboxes diff my-project     # the working tree against HEAD, tracked and new files
bin/ncl sandboxes stop my-project     # interrupt the current turn (Escape in the session)
```

`diff` runs git inside the running session container, as the container's
user, with the repository's external diff driver, textconv filters and
fsmonitor hook switched off; the Host never runs git against the agent's
tree. A cold sandbox has no diff until it wakes. The output is bounded (a
cut is marked as such).

## How the agent works

The session's working directory is `/workspace/group`. On every spawn the
Host stamps the operating manual from `container/code-mode/CLAUDE.md` at
that directory's `CLAUDE.md`, and the dev skills from
`container/code-mode/skills/*` under `.claude/skills/`, both read-only. The
manual tells the agent how mail arrives, how to reply, how to work in the
tree and what it must not do; `dev-git` covers checking a repository out
into the working directory and committing cleanly; `dev-toolchains` covers
installing project toolchains under the persistent `/workspace/tools`. A
fork edits these files to change what its agents are told. A checkout
missing them still boots the session, and `sandboxes new` and `sandboxes
list` say so.

Each sandbox session owns one Claude Code conversation, named by an id the
runner keeps in the session directory (`code-session.json`, derived from
the session id). The first life of the session starts the conversation
under that id; every later life — a wake after the idle lease, a crash of
the CLI inside the container — resumes it by id, so two sessions of the
same group sharing a `~/.claude` store never continue each other's
conversation. The CLI's SessionStart hook keeps the record current: after
`/clear` the new conversation's id replaces the old one, and the next life
resumes the conversation the operator was actually in. A resumed
conversation the CLI cannot load is abandoned for a fresh one, once per
boot, with both ids in the container log.

Messages for the group arrive as mail. While the agent is idle the runner
types them into the session as a prompt; while a turn runs a notice on the
next tool result says how many are waiting. A file sent with a message is
staged by the Host and appears after the text as `[type: name — saved to
/workspace/inbox/<message id>/<name>]`, with or without a caption; `ncl
inbox read --id` returns the same attachments structured. Inside the
container:

```sh
ncl inbox read                 # show and consume waiting mail
ncl inbox read --peek          # look without consuming
ncl outbox send --text "..."   # post to the chat surface bound to this session
```

A send with no `--reply-to` goes to the session's default route: the chat
surface bound to the session (below), or nowhere, in which case it fails and
says so.

## Permissions and the sandbox boundary

Inside the container most tool use runs without prompts. Writes to the
manual, to the CLI's settings file and to the Host's permission policy are
boundaries: the CLI asks, and when nobody is attached the question becomes
an approval card delivered to an approver the way other approvals are. A
card nobody answers is denied before the CLI's own timeout; a Host restart
denies every open question. The decision reaches the container through a
read-only mount, so the agent cannot approve its own boundary crossing.

What the card says is another matter. The request file rides the
read-write workspace, so an agent can write a request that describes an
action other than the one its hook is holding: the transport blocks
self-approval, not a misleading card. Treat a boundary card as the agent
asking, and read it the way you would read the agent's own message.

`NANOCLAW_CODE_PERMISSION_MODE` (`auto`, the default, or `bypass`) sets the
deployment posture; `--permission-mode` on `sandboxes new`, or
`--permission-mode` on `groups config update`, overrides it per group.
`bypass` must be selected explicitly. The Host composes the posture into a
managed-settings file mounted read-only at the CLI's admin tier, so the
agent cannot out-write it from any settings layer it can reach.

## A chat surface for a coding session

A chat platform can be a surface for a coding session: status while a turn
runs, the diff after each turn, messages both ways, and a Stop that
interrupts the turn. Code mode keeps everything a platform does not need
to know — the mapper from the runner's turn stamp to a status, the diff
collection (inside the session container, as above), the interrupt, the
binding table and its wiring into the session, the runtime that ticks and
long-polls — and asks the platform
for one object, a `SessionSurfaceProvider` (`src/code-mode/surface/types.ts`):
open a surface for a sandbox, spell it the way the adapter's inbound path
will, accept a status or a view, report events, close. A provider registers
with `registerSessionSurface(channelType, provider, { seam:
SESSION_SURFACE_SEAM })`; with none registered, sandboxes are plain and the
terminal verbs above are the surface.

When a provider is registered, `sandboxes new` opens a surface for the new
session through it and wires the sandbox to the surface with an ordinary
group ↔ chat wiring in session mode `sandbox`: every message on the
surface lands in the coding session, no mention needed, threads never
apply, and the surface becomes the session's default outbound route. A
conversation the adapter registered before the bind is adopted, not
duplicated. `sandboxes status` shows the binding.

A binding whose provider is not registered — the Host restored it at start
before the platform's module activated, or the module left — waits: nothing
is sent or recorded for it, `sandboxes status` shows it as not mirrored,
and it goes live the moment a provider for its platform registers. The
diff for a completed turn stays pending until the provider took it; a
failed read of the tree (the exec, git) or a failed publish is retried on
the next healthy tick, three times, before that turn is given up with a
log line. A clean tree is not a failure: it settles the turn with nothing
sent.

## Configuration and dependencies

Code mode uses the existing agent image, Claude Code installation, and
mailbox. The image adds the distribution's `tmux` package. Workspace
toolchains persist under `/workspace/tools`.

`NANOCLAW_CODE_IDLE_TTL_MS` and `NANOCLAW_CODE_ATTACH_IDLE_TTL_MS` control
idle retirement (defaults: 30 minutes unattached, 24 hours attached).
`NANOCLAW_CODE_CHANNELS` (`dev` or `org`) delivers mail to the session
through Claude Code's MCP channels (a research preview of the CLI) instead
of typing it; unset, mail is typed into the terminal when the agent is
idle. `NANOCLAW_CODE_ENV` is a JSON object of extra environment variables
for code-mode containers; it never overrides the provider's credential
lane.

Code mode currently supports the `claude` provider only.

## Extending code mode

Modules attach without editing code mode:

- `src/code-mode/hooks.ts`: `onSandboxCreated`, `onSandboxBound`,
  `onSandboxRemoved`, `onRemoteAccessChanged` — named callbacks, awaited
  in order, a throwing listener logged and skipped;
- `extendResource('sandboxes', { … }, { seam })` in `src/cli/crud.ts`:
  extra sub-verbs on `ncl sandboxes`;
- `registerSessionSurface(channelType, provider, { seam })`: a chat
  platform as a session surface;
- `src/code-mode/sandboxes.ts`: the in-process `create` / `list` / `attach`
  the verbs run, for a host component that lands a terminal in a sandbox
  itself (the `AttachTarget` carries the live session handle and the
  command; `SessionHandle.execStream` holds the exec in-process where the
  driver offers it).

Every registry carries a seam version. A registration on the wrong integer
is refused, logged, and shown above `ncl sandboxes list`; the host boots
either way. Contract-test helpers (`assertSandboxHook`, `assertSandboxVerb`,
`assertSurfaceRegistered` under `src/code-mode/`) let a module's test prove
its registration against the real composed tree.
