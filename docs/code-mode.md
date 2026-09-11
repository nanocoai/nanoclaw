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

## Remote terminal

Remote terminal access lets an approved SSH key land in a sandbox on this
Host from another machine. The Host runs a dedicated OpenSSH listener on
loopback, with its own host key, public keys only, a PTY and nothing else:
no shell, no forwarding, no password. Reachability over the network arrives
with the account link work; until then the listener answers only on the
Host itself (or through a tunnel you run yourself), and every stream that
reaches it is expected to be relayed by the Host.

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
`data/door/`, takes the first free loopback port in 33022–33121, writes an
`sshd_config`, starts the listener under the Host, and keeps it running
across Host restarts until you disable it. Disabling keeps the host key and
the approved keys. The Host needs an OpenSSH server binary (`sshd`) and
`ssh-keygen`; set `NANOCLAW_SSHD` if the binary is somewhere unusual.

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
authentication.

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
needs an OpenSSH client on the terminal machine and the OpenSSH server
(`sshd`, `ssh-keygen`) on the Host; it depends only on Node built-ins.
`NANOCLAW_SSHD` names the server binary when it is not on the usual paths;
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
