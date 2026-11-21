---
name: add-apple-container
description: Run agent sessions on Apple container (macOS lightweight VMs) instead of Docker — a session-driver overlay for the driver seam. Use when the operator wants each session in its own VM, wants to run without Docker Desktop, or asks for Apple container support. macOS 26 on Apple silicon with the `container` CLI installed.
---

# Add Apple container driver

Runs NanoClaw agent sessions on [Apple container](https://github.com/apple/container)
instead of Docker. Each session is its own lightweight VM. The driver registers under
kind `container` through `src/drivers/installed.ts` and is selected per install with
`NANOCLAW_RUNTIME_DRIVER=container`. The Docker driver stays the default for every
install that does not select this one.

The driver carries the runtime knowledge the seam cannot: which hardening flags this
CLI rejects, the `host.docker.internal` rewrite (the runtime has no `--add-host` and its
VMs cannot resolve that name), nested file mounts
([apple/container#2148](https://github.com/apple/container/issues/2148)), JSON
list/inspect parsing for both `status` shapes, and `container system start` when the
runtime is down.

## Requirements

- A Mac with Apple silicon running macOS 26 (the release Apple's `container` supports).
- The `container` CLI 1.5.0 or newer, on `PATH`. Install it from
  [the releases page](https://github.com/apple/container/releases) and run
  `container system start` once.

Check the installed version:

```nc:run effect:check
v=$(container --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1) && [ "$(printf '%s\n' 1.5.0 "$v" | sort -V | head -1)" = 1.5.0 ]
```

If this fails, install or upgrade `container` before continuing.

## Install

### 1. Copy the driver

Copy the driver, its registration module, and its tests from this skill's `payload/`
into `src/drivers/`, overwriting any older copies:

```nc:copy
payload/src/drivers/apple-container-driver.ts -> src/drivers/apple-container-driver.ts
payload/src/drivers/apple-container-registration.ts -> src/drivers/apple-container-registration.ts
payload/src/drivers/apple-container-registration.test.ts -> src/drivers/apple-container-registration.test.ts
payload/src/drivers/apple-container-driver.test.ts -> src/drivers/apple-container-driver.test.ts
payload/src/drivers/apple-nested-mounts.test.ts -> src/drivers/apple-nested-mounts.test.ts
payload/src/drivers/apple-container-cli-contract.test.ts -> src/drivers/apple-container-cli-contract.test.ts
```

### 2. Register the driver

Append this line to `src/drivers/installed.ts` if it is not already there. It must
appear exactly once; a second copy throws `Session driver already registered` at startup.

```nc:append to:src/drivers/installed.ts
import './apple-container-registration.js';
```

### 3. Select the driver

Add to `.env` (left alone if already set):

```nc:env-set
NANOCLAW_RUNTIME_DRIVER=container
```

`container/build.sh` and the update controller pick their runtime from the
`CONTAINER_RUNTIME` environment variable, not from `.env`. Without it they build the
agent image into Docker and drain Docker containers during an update. Tell the user:

```nc:operator
Add this line to your shell profile (for zsh, ~/.zshrc), then open a new terminal:

    export CONTAINER_RUNTIME=container

Every shell that runs ./container/build.sh or /update-nanoclaw needs it.
```

### 4. Build and test

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/drivers/
```

`apple-container-registration.test.ts` imports the real driver barrel and fails if the
import line is missing. `apple-container-cli-contract.test.ts` runs read-only commands
against the installed `container` binary and skips itself where the binary is absent.

### 5. Build the image and restart

With `CONTAINER_RUNTIME=container` exported, build the agent image into Apple
container's image store, then restart the NanoClaw service:

```bash
./container/build.sh
```

The boot log's `Session runtime driver selected` line must report `driver="container"`.

### After updating NanoClaw

`/update-skills` refreshes channels, providers and gateways, not drivers. Re-run this
skill after an update so the driver files match the skill's payload.

## How it differs from the Docker driver

- **Nested file mounts are never passed to the runtime.** A file mount whose
  destination sits inside another mount replaces the whole parent share in the guest
  (apple/container#2148). When the parent share already holds the same file (the
  composed `AGENTS.md` and `container.json`), the mount is dropped. When the content
  differs (for example the Codex sign-in stub at `~/.codex/auth.json` inside the
  `.codex-shared` share), the driver copies the file into the root of the parent share
  on the host. The copy never follows a symlink and never blocks on a FIFO. Anything it
  cannot copy (read-only or install shares, a path below the share root, a directory in
  the way) is dropped with a warning. The cost is the nested mount's read-only
  protection.
- **`host.docker.internal` is rewritten to the bridge gateway IP in env values.** The
  runtime has no `--add-host` and its VMs cannot resolve the name. Resolution order:
  `CONTAINER_HOST_GATEWAY` in the process environment, then `container network inspect default`,
  looked up on every spawn. If the lookup fails, the session does not start. There is no
  fallback address.
- **No sidecar containers.** `capabilities().auxiliaryContainers` is false; a spec with
  a non-agent container is refused.
- **Hardening flags.** This CLI rejects `--security-opt` and `--pids-limit` (exit 64).
  The pids cap is passed as `--ulimit nproc=N`. `no-new-privileges` has no equivalent.

## Troubleshooting

- **Containers lose outbound network after a macOS update or reboot.** Short requests
  may still work while long-lived connections fail. Run
  `container system stop && container system start`. The driver starts a stopped
  runtime but cannot detect this degraded state.
- **Image build dies with `cannot allocate memory` or `Killed`.** Each bare
  `container build` recreates the builder VM with 2 GiB. `container/build.sh` passes
  `-m` (default `8G`, override with `CONTAINER_BUILDER_MEM`) when
  `CONTAINER_RUNTIME=container`. Check that the variable is exported.
- **The image was built but sessions cannot find it.** It went into Docker:
  `CONTAINER_RUNTIME` was not exported in the shell that ran `./container/build.sh`.
- **Sessions do not start and the host log says `Could not detect the container host
  gateway`.** The driver could not look up the bridge gateway, so it refused to start
  the session rather than give it a wrong proxy address. The host retries on its next
  sweep (every minute). Check that
  `container network inspect default` reports an `ipv4Gateway` (restart the runtime if
  it fails), or set `CONTAINER_HOST_GATEWAY` in the NanoClaw service's environment (its
  launchd plist). The driver reads it from the process environment, not from `.env`.
- **The bridge subnet can change.** When `[network] subnet` is unset in
  `~/.config/container/config.toml`, 1.5.0 picks the default network's subnet when the
  runtime starts, and a runtime restart can move it (for example from 192.168.64.0/24
  to 192.168.65.0/24). The runtime copies that file into its app root
  (`config/config.toml`) at start. The driver looks the gateway up again for every
  session, so new sessions follow the move. Do not pin the subnet in `config.toml`: on
  one host, pinning 192.168.64.0/24 made vmnet fail to start (`vmnet_return_t 1001`).
  Host services that containers call should find the gateway at runtime
  (`container network inspect default`), not hardcode it.
- **A group's file is missing or stale inside the container.** Look in the host log for
  `Nested file mount copied into its parent share` or `Dropping nested file mount` (with
  a `reason`). For a dropped `additionalMounts` file, mount its parent directory instead.
- **Disk use grows with every rebuild.** Replacing an image under an existing tag leaves
  the old unpacked snapshot behind until `container image prune` runs
  ([apple/container#2164](https://github.com/apple/container/issues/2164)).
  `container/build.sh` prunes dangling images after each build when
  `CONTAINER_RUNTIME=container`; set `NANOCLAW_SKIP_SNAPSHOT_PRUNE=true` to keep them.
  Never use `container image prune -a`: with no session running it removes every image,
  including the one just built.
- **There is no `container ps`.** Use `container list --all`.
