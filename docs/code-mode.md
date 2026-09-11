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

**Remote attach: not yet wired after the portal client rewrite.**

The design is an SSH session relayed through the community portal: the Host
keeps its existing outbound connection to its account cell, runs a dedicated
OpenSSH listener on loopback with its own host key, and admits only terminal
keys the account owner authorized in the browser, each pinned to a forced
command that accepts sandbox creation, listing, and attachment. The private
key stays on the terminal machine, SSH encrypts the terminal traffic end to
end, and the terminal pins the Host's key.

None of that ships in this repository yet: the portal contract carries no
code-mode routes, and the cell link defines no `ssh` channel kind. Until it
does, attach locally with `bin/ncl sandboxes attach`, or over your own SSH
access to the Host.

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
The image adds the distribution's `tmux` package. Remote terminal access, once
wired, needs an OpenSSH client on the terminal machine and OpenSSH server on
the receiving Host; it depends only on Node built-ins.

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
