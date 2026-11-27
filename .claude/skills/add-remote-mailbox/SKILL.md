---
name: add-remote-mailbox
description: Give chosen agent groups a remote session mailbox — the agent container reaches its inbound/outbound mailbox over HTTP through a loopback host service instead of having the session directory mounted. Per group via NANOCLAW_REMOTE_MAILBOX_GROUPS; selected with NANOCLAW_RUNTIME_DRIVER=remote-mailbox, a session driver that wraps the default Docker driver.
---

# Remote agent mailbox

By default every agent container gets its session directory (`inbound.db`,
`outbound.db`, outbox, heartbeat) mounted at `/workspace`. This skill lets
chosen agent groups run without that mount: their runner reaches the mailbox
over HTTP through a host service on `127.0.0.1` (port 18770 by default), with a
bearer token issued per spawn and revoked when the container ends. Everything
else about the container is unchanged.

Tested on macOS with Docker Desktop. On Linux a container cannot reach the
host's `127.0.0.1`, so the host service is out of reach there.

How it fits together:

- **Host service** (`src/mailbox/remote/service.ts`) runs the runner's mailbox
  operations against the session's SQLite files on the host. It listens only
  when at least one group is listed.
- **Mailbox forwarder** (`src/mailbox/remote/forwarder.ts`), under egress
  lockdown only: a container on the locked-down network that forwards the
  mailbox port, and nothing else, to the host.
- **Session driver** `remote-mailbox` (`src/mailbox/remote/driver.ts`) wraps the
  install's `docker` driver, or the registered driver
  `NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER` names. For a listed group it swaps the
  `/workspace` mount for an empty per-session scratch directory, adds the
  mailbox URL, token and session to the container env, and binds a small
  per-session directory whose heartbeat file the host sees at
  `<sessionDir>/.heartbeat`. When the container ends it revokes the tokens and
  deletes the scratch directory. Other groups pass through untouched.
- **Runner** (`container/agent-runner/src/mailbox/compose.ts`) picks the HTTP
  mailbox when `NANOCLAW_MAILBOX_URL` is set and the SQLite mailbox otherwise.

`src/mailbox/remote/operations.ts` is a host copy of the runner's SQLite
mailbox code. `src/mailbox/remote/drift.test.ts` fails when upstream changes
the runner files it was copied from; review `operations.ts` against the change,
then update the fingerprint the failure message prints.

## Install

### 1. Check the core seams

The skill needs the session-driver registry, the singular runner mailbox slot
and the runner's configurable heartbeat path. Update core first if this fails.

```nc:run effect:check
test -f src/drivers/installed.ts && grep -q "export function getSessionDriverFactory" src/drivers/driver-registry.ts && grep -q "export function onHostShutdown" src/host-lifecycle.ts && grep -q "export function sessionMailboxDir" src/mailbox/sqlite/paths.ts && grep -q "NANOCLAW_HEARTBEAT_PATH" container/agent-runner/src/heartbeat.ts && grep -q "registerAgentMailbox" container/agent-runner/src/mailbox/compose.ts
```

### 2. Copy the skill files

Copy each file below from this skill's `payload/` to the same path at the
project root, overwriting any older copy.

```nc:copy
payload/src/mailbox/remote/config.ts -> src/mailbox/remote/config.ts
payload/src/mailbox/remote/drift.test.ts -> src/mailbox/remote/drift.test.ts
payload/src/mailbox/remote/driver.test.ts -> src/mailbox/remote/driver.test.ts
payload/src/mailbox/remote/driver.ts -> src/mailbox/remote/driver.ts
payload/src/mailbox/remote/files.ts -> src/mailbox/remote/files.ts
payload/src/mailbox/remote/forwarder.test.ts -> src/mailbox/remote/forwarder.test.ts
payload/src/mailbox/remote/forwarder.ts -> src/mailbox/remote/forwarder.ts
payload/src/mailbox/remote/ids.ts -> src/mailbox/remote/ids.ts
payload/src/mailbox/remote/index.ts -> src/mailbox/remote/index.ts
payload/src/mailbox/remote/operations.test.ts -> src/mailbox/remote/operations.test.ts
payload/src/mailbox/remote/operations.ts -> src/mailbox/remote/operations.ts
payload/src/mailbox/remote/service.test.ts -> src/mailbox/remote/service.test.ts
payload/src/mailbox/remote/service.ts -> src/mailbox/remote/service.ts
payload/src/mailbox/remote/spawn.test.ts -> src/mailbox/remote/spawn.test.ts
payload/src/mailbox/remote/spawn.ts -> src/mailbox/remote/spawn.ts
payload/src/mailbox/remote/startup.test.ts -> src/mailbox/remote/startup.test.ts
payload/src/mailbox/remote/startup.ts -> src/mailbox/remote/startup.ts
payload/src/mailbox/remote/test-fixture.ts -> src/mailbox/remote/test-fixture.ts
payload/src/mailbox/remote/tokens.test.ts -> src/mailbox/remote/tokens.test.ts
payload/src/mailbox/remote/tokens.ts -> src/mailbox/remote/tokens.ts
payload/container/agent-runner/src/mailbox/remote/fake-host.server.ts -> container/agent-runner/src/mailbox/remote/fake-host.server.ts
payload/container/agent-runner/src/mailbox/remote/fake-host.ts -> container/agent-runner/src/mailbox/remote/fake-host.ts
payload/container/agent-runner/src/mailbox/remote/files.ts -> container/agent-runner/src/mailbox/remote/files.ts
payload/container/agent-runner/src/mailbox/remote/index.ts -> container/agent-runner/src/mailbox/remote/index.ts
payload/container/agent-runner/src/mailbox/remote/remote.test.ts -> container/agent-runner/src/mailbox/remote/remote.test.ts
payload/container/agent-runner/src/mailbox/remote/rpc-worker.ts -> container/agent-runner/src/mailbox/remote/rpc-worker.ts
payload/container/agent-runner/src/mailbox/remote/sync-rpc.ts -> container/agent-runner/src/mailbox/remote/sync-rpc.ts
```

### 3. Replace the runner's mailbox slot

`container/agent-runner/src/mailbox/compose.ts` is the runner's one mailbox
registration. Replace it with this skill's version, which keeps SQLite as the
default and adds the HTTP mailbox. Leave the import of `compose.js` in the
runner's modules barrel as it is.

```nc:run effect:refresh
cp .claude/skills/add-remote-mailbox/payload/container/agent-runner/src/mailbox/compose.ts container/agent-runner/src/mailbox/compose.ts
```

### 4. Register the session driver

Append this line to `src/drivers/installed.ts`, keeping the existing lines:

```nc:append to:src/drivers/installed.ts
import '../mailbox/remote/driver.js';
```

### 5. Build and test

The build covers the typed calls into core. The tests drive the driver through
the real drivers barrel, container-runner and session-events hub, check the
host copy of the mailbox SQL against upstream, and typecheck the runner.

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/mailbox/remote
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

Run the runner's own tests too when Bun is available: `cd container/agent-runner && bun test src/mailbox/remote`.

### 6. Choose the groups

Ask the user which agent groups should use the remote mailbox. `ncl groups list`
shows their ids.

```nc:prompt remote_mailbox_groups validate:^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$
Which agent group ids should use the remote mailbox? Comma-separated, no spaces (for example ag-123,ag-456).
```

Write the groups and select the driver in `.env`. Both settings are needed: the
listed groups keep the mounted session directory until the driver is selected,
and the host logs an error saying so. `NANOCLAW_MAILBOX_PORT` (default 18770)
moves the host service if that port is taken. `NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER`
(default `docker`) names the driver this one wraps; a runtime skill such as
`/add-openshell` sets it.

```nc:env-set
NANOCLAW_REMOTE_MAILBOX_GROUPS={{remote_mailbox_groups}}
NANOCLAW_RUNTIME_DRIVER=remote-mailbox
```

If `.env` already sets either key to something else, update it by hand.

### 7. Egress lockdown

Nothing to do. With `NANOCLAW_EGRESS_LOCKDOWN=true` the host also runs one
small forwarder container, `nanoclaw-mailbox-<slug>`, on the locked-down
network. It forwards only the mailbox port to the host, and listed groups
reach their mailbox through it.

### 8. Restart

```nc:run effect:restart
bash setup/lib/restart.sh
```

Running containers keep the mailbox they started with. A listed group switches
on its next spawn; `ncl groups restart --id <group-id>` does it now.

## Verify

`logs/nanoclaw.log` shows `Session runtime driver selected` with
`remote-mailbox(docker)` and `Remote mailbox service listening`, plus
`Remote mailbox forwarder up` under egress lockdown. After a listed
group's next message, its container has no mount of
`data/v2-sessions/<group>/<session>` (`docker inspect <container>` shows
`.remote-workspace/<session>` at `/workspace` and `.remote-workspace/<session>.hb`
at `/opt/nanoclaw-heartbeat`), and the session's heartbeat keeps updating.

## Troubleshooting

- **`NANOCLAW_REMOTE_MAILBOX_GROUPS is set but NANOCLAW_RUNTIME_DRIVER is not 'remote-mailbox'`**:
  set `NANOCLAW_RUNTIME_DRIVER=remote-mailbox` in `.env` and restart.
- **Host refuses to start with `EADDRINUSE`**: another process holds the
  mailbox port. Set `NANOCLAW_MAILBOX_PORT` to a free port and restart.
- **Host refuses to start with `Remote mailbox under egress lockdown: ...`**:
  the forwarder container could not be set up; the message says why (Docker
  not running, agent image missing). Fix that and restart.
- **Agent never answers, runner logs mailbox connection errors**: a container
  started before the forwarder existed still has the old mailbox address.
  Restart the group with `ncl groups restart --id <group-id>`.
- **`drift.test.ts` fails after an update**: upstream changed the runner's
  SQLite mailbox. Port the change into `src/mailbox/remote/operations.ts`, run
  `operations.test.ts`, then update the fingerprint.

## Remove

See [REMOVE.md](REMOVE.md).
