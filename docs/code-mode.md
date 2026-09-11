# Code mode

Code mode runs Claude Code in a persistent tmux session inside an agent
container. The workspace survives container restarts. Detaching a terminal
leaves the agent running; attaching to a cold sandbox starts its container.

## Local terminal

Rebuild the agent image after updating, then start the Host normally.
From the Host checkout:

```sh
bin/ncl sandboxes new my-project
bin/ncl sandboxes list
bin/ncl sandboxes attach my-project
```

Detach with **Ctrl-b, then d**. Existing groups can use code mode through
`bin/ncl groups config update <group> --code-mode true`, followed by
`bin/ncl groups restart <group>`. `bin/ncl groups attach <group>` shares the
same terminal implementation as sandbox attachment. Agents cannot invoke
these Host-only terminal commands through their mailbox.

## Chat surface for a coding session

On a Host whose Slack app was set up through the NanoClaw Slack service,
`bin/ncl sandboxes new` also opens a Slack channel for the new session.
The service creates the channel, invites the Host's bot, and sends the
person who connected the workspace a short direct message that the channel
starts from. Nothing changes for sandboxes created with `--no-channel`, or
on a Host without such an app, or in a workspace where the service cannot
open channels yet; the sandbox works the same without one.

What the channel shows:

- **Messages both ways.** A message in the channel is delivered into the
  coding session like any other chat message; the agent's replies
  (`ncl outbox send`) come back to the channel. No mention is needed. The
  channel is also the session's default outbound route: a send with no
  `--reply-to` posts to it, a send with one answers in that message's thread.
- **Status.** The channel shows the session as working while a turn runs,
  idle between turns, and suspended when the session container has been
  retired by the idle lease. It resumes when the next message wakes it.
- **Changes.** After each completed turn the Host posts the working tree's
  diff (tracked and new files, at most 200 KB) to the channel's code view.
- **Stop.** Stopping the session from the channel interrupts the current
  turn in the terminal. The session stays attached and the channel stays
  open; the next message from the channel or the terminal resumes it.

The Host mirrors the session by reading a small state file the session's
hooks write into the workspace, so a session that was attached before the
Host restarted keeps its channel. Manual checks:

```sh
bin/ncl sandboxes channel status my-project
bin/ncl sandboxes channel archive my-project --summary "Shipped the page."
```

Archiving is always explicit; neither a Stop nor deleting the sandbox
archives the channel. To try it end to end: create a sandbox, post a
request in the new channel, watch the status move and the diff view fill
after the turn, press Stop mid-turn and confirm the terminal shows the
interrupted turn, then send another message and confirm the session
resumes. A Host with no managed Slack app skips all of this silently.

## Remote terminal

Remote terminal access lets an approved SSH key land in a sandbox on this
Host from another machine. The Host runs its own SSH server, in-process, on
loopback: its own host key, public keys only, any username (the key decides,
not the login name), a terminal and nothing else — no shell, no forwarding,
no file transfer, no password. Reachability comes from the account
link, not from a listener of its own: the Host never listens on the network,
and every stream that reaches the listener was relayed by the Host (see
Streams below).

### Enabling

```sh
bin/ncl sandboxes remote enable [--name my-machine]
bin/ncl sandboxes remote status
bin/ncl sandboxes remote disable
```

The name is a DNS label: 3–32 lowercase letters, digits and single hyphens,
with a few common words reserved. It becomes this machine's address once the
link relays terminals, and it names the default sandbox a remote terminal
lands in. When the account link is connected the account confirms or assigns
the name (omit `--name` to let it choose) and the command prints the address
to use; a name renamed later in the browser is reported as a changed address.
Without the link, pass `--name`. Enabling generates the host key once under
`data/door/`, takes the first free loopback port in 33022–33121, starts the
server inside the Host, and keeps it running across Host restarts until you
disable it. Disabling ends open sessions and keeps the host key and the
approved keys. Nothing has to be installed or configured on the Host for
this: no OpenSSH server, no extra account, no membership in any system group
such as `tty`, no native module. The server is part of the Host process, and
the terminal a session gets is the container runtime's own, opened through
the same runtime API the Host already manages sessions with.

### Keys and pairing

Every key the listener sees is admitted to exactly one program:

- an approved key lands in a sandbox (next section);
- an unknown key enters the waiting room, which prints the key's
  fingerprint, where the connection came from, the time, the approval page
  and (through the account link) a short approval code, then waits up to
  ten minutes. Approve it from the Host or in the browser and the same
  session continues into the sandbox without reconnecting. A machine holds
  at most four waiting rooms at once and records at most ten pending keys per
  ten minutes; beyond that the room says so and ends.

```sh
bin/ncl sandboxes remote keys add ~/.ssh/id_ed25519.pub --label laptop
bin/ncl sandboxes remote keys list
bin/ncl sandboxes remote keys approve SHA256:…
bin/ncl sandboxes remote keys revoke SHA256:…
```

Fingerprints are the `SHA256:…` form `ssh-keygen -lf` prints. Revoking a
key ends its open sessions and sends it back to the waiting room on its next
connection. Keys approved in the browser reach the Host with the account's
snapshot and are revoked there; `keys list` shows them separately. The
approval page shown in the waiting room is `NANOCLAW_TERMINAL_APPROVAL_URL`
(default `https://portal.nanoclaw.dev/terminals`) until the account link
supplies the page and code.

### Landing

The Host records what each relayed stream is for. A stream for the account
lands in the default sandbox named after the account, created on first use;
a stream for a named sandbox attaches that sandbox, waking it if it went
cold. `ssh <address> ls` prints the sandbox list instead of landing. Detach
with **Ctrl-b, then d**; the session keeps running. A connection the Host
did not relay (for example a direct loopback connection) is refused after
authentication. While remote access is enabled, `ncl sandboxes new` also
registers the new sandbox's name with the account so it gets an address of
its own, and deleting the group frees it; both are best effort and never get
in the way of the sandbox itself.

### Streams

Remote streams ride the Host's existing outbound link to its account cell.
While remote access is enabled the link announces the `ssh` capability, and
every terminal the cell relays arrives as one `ssh` channel: the Host
connects to the listener on 127.0.0.1 from a distinct loopback source port,
records which account or sandbox that port is for (the forced command looks
it up by its client port), and pipes bytes both ways in 16 KiB chunks under
a 64 KiB per-direction window, acknowledging a chunk only once the listener
has taken it. The last bytes of a session are acknowledged before the stream
closes; a dropped link tears every stream down, and the terminal reconnects
into the same tmux session. Enabling or disabling remote access restarts the
link so the capability is re-announced, the Host renews its link ticket
every ten minutes so streams outlive it, and at most eight streams are open
at once. Approvals made in the browser reach the Host with the account's
snapshot over the same link.

## Connection recovery (design)

- Interrupted attachment retries with fresh authorization and SSH for up to
  two minutes, measured from the interruption. Longer outages require another
  attach command. Successful recovery redraws the existing tmux session.
- Clean detach, sign-out, revocation, authentication failure, and a changed
  Host key stop recovery. Temporary network and API failures retry with jitter.
- Creation runs once before attachment. An ambiguous creation response is
  reported for inspection; creation and terminal keystrokes are never replayed.
- Each stream direction permits 64 KiB of unacknowledged data in 16 KiB frames.
  Both endpoints and the relay enforce that limit. One account cell admits
  at most eight streams, and closing one stream leaves the others running.
- Heartbeats detect silent connections. Short-lived tickets renew without
  replacing stream counters. Final bytes drain before the stream closes.
- Host shutdown, including a hard crash, retires its dedicated SSH listener.
  A replacement Host can reconnect to the surviving agent container.

## Configuration and dependencies

Code mode uses the existing agent image, Claude Code installation, and mailbox.
The image adds the distribution's `tmux` package. Remote terminal access
needs an SSH client on the terminal machine; the Host side is the Host
process itself (the `ssh2` protocol library) and the container runtime's
exec API, which the Host already uses to run sessions.
`NANOCLAW_TERMINAL_APPROVAL_URL` is the approval page the waiting room shows.

`NANOCLAW_CODE_PERMISSION_MODE` defaults to `auto`. A group's
`--permission-mode auto|bypass` overrides it; bypass must be explicitly selected.
The Host stamps the instruction and permission files into read-only mounts.
Workspace toolchains can persist under `/workspace/tools`.

`NANOCLAW_CODE_IDLE_TTL_MS` and `NANOCLAW_CODE_ATTACH_IDLE_TTL_MS` control idle
session retirement. `NANOCLAW_CODE_CHANNELS` (`dev` or `org`) delivers mailbox
messages to the session through Claude Code's MCP channels (a research
preview of the CLI, unrelated to Slack channels) instead of typing them;
unset, messages are typed into the terminal when the agent is idle. `NANOCLAW_CODE_ENV` is a JSON object of extra environment variables for
code-mode containers. Choose an attached idle lease longer than the reconnect
budget if the same process must survive a sustained outage.
