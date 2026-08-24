---
name: add-apple-container
description: Run agent sessions on Apple Container (macOS microVMs) — a session-driver overlay for the driver seam. Each session gets its own lightweight VM with a stronger isolation boundary than a shared-kernel namespace. macOS 15+ on Apple Silicon with the `container` CLI installed.
---

# Add Apple Container Driver

Runs NanoClaw agent sessions on [Apple Container](https://github.com/apple/container)
instead of Docker: each session is its own microVM. The driver is a session-driver
overlay (`src/drivers/`, kind `container`) — it self-registers through
`installed.ts` and is selected per-install with `NANOCLAW_RUNTIME_DRIVER=container`.
Docker installs are untouched; the docker driver remains the default.

The driver passes the full driver conformance suite unchanged (its harness rides
`src/drivers/conformance.test.ts`), and carries the Apple-runtime knowledge the
seam cannot: which hardening flags the CLI rejects, the
`host.docker.internal` rewrite (the runtime has no `--add-host` and VMs cannot
resolve that name), the nested-file-mount collapse
([apple/container#2148](https://github.com/apple/container/issues/2148)), JSON
list/inspect parsing across both historical `status` shapes, and
`container system start` recovery on a cold or stale runtime.

## Requirements

- macOS 15+ on Apple Silicon
- The `container` CLI installed and on `PATH` (`brew install container`), 1.2.x or newer

Verify before installing:

```nc:run effect:check
container --version
```

## Install

### 1. Driver payload

Fetch the driver, its registration module, and its tests from the registry
branch (additive fetch, never a merge):

```nc:copy from-branch:drivers
src/drivers/apple-container-driver.ts
src/drivers/apple-container-registration.ts
src/drivers/apple-container-driver.test.ts
src/drivers/conformance.test.ts
```

The `conformance.test.ts` copy is the trunk file plus this driver's harness —
the suite is designed for exactly that addition, and the registry branch keeps
it in sync with `main`.

### 2. Barrel registration

Append the self-registration import to the drivers barrel (skipped if the line
is already present):

```nc:append to:src/drivers/installed.ts
import './apple-container-registration.js';
```

### 3. Select the driver

```nc:env-set NANOCLAW_RUNTIME_DRIVER
container
```

`CONTAINER_RUNTIME=container` should also be set in `.env` so the non-session
shell-outs (per-group image builds, `container/build.sh`) target the same
runtime the sessions run on:

```nc:env-set CONTAINER_RUNTIME
container
```

### 4. Build and verify

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm vitest run src/drivers/
```

The conformance suite now runs every case against both the docker and
apple-container harnesses; the driver-specific file covers the Apple-only
behavior (hardening arg shape, gateway env rewrite, nested-file-mount drop,
system-start recovery, label-scoped listing and reaping).

### 5. Restart

Restart the NanoClaw service. The boot log's `Session runtime driver selected`
line must report `driver="container"` — that log line is the discriminator for
a mis-selected driver (see `src/drivers/index.ts`).

## How it differs from the docker realization

Two deliberate deviations, both declared in the driver header:

- **Nested file mounts are dropped, loudly.** A single-file bind whose
  destination sits inside another share REPLACES the parent share in the guest
  (apple/container#2148). Refusing such specs would brick stock composition
  (the `container.json` nested-RO mount is unconditional), and mounting anyway
  destroys the parent share silently — strictly worse. The driver drops the
  nested file mount with one warning per spawn; the real file stays visible
  through the parent share. The cost is that mount's read-only protection,
  bounded by per-spawn host-side re-materialization.
- **`host.docker.internal` is rewritten to the bridge gateway IP in env
  values.** The runtime has no `--add-host` and its VMs cannot resolve the
  name, so a byte-identical pass-through ships a value that can never work.
  Resolution order: `CONTAINER_HOST_GATEWAY` override, then
  `container network inspect default`, then a bridge interface scan — never a
  hardcoded constant.

Also: `--security-opt` and `--pids-limit` are rejected by this CLI (exit 64);
the pids cap is realized as `--ulimit nproc=N`, which in a single-VM session is
the same bound. `no-new-privileges` has no equivalent — each session being its
own kernel is the stronger boundary.

## Troubleshooting

- **Image build dies with `cannot allocate memory` / `Killed`.** Every bare
  `container build` re-creates the builder VM at a 2 GiB default — a builder
  started separately with more memory does not survive the next bare
  invocation. `container/build.sh` passes `-m` (default `8G`, override with
  `CONTAINER_BUILDER_MEM`) whenever `CONTAINER_RUNTIME=container`.
- **Container egress black-holes after a host reboot or runtime update.**
  Stale vmnet state ([apple/container#2051](https://github.com/apple/container/issues/2051)
  is the likely mechanism): short requests may still work while long-lived
  connections fail. `container system stop && container system start`
  reinitializes it; the driver's `ensureReady` starts a stopped runtime but
  cannot detect this degraded state.
- **Credentialed calls fail with connection-refused inside sessions.** The
  gateway rewrite could not resolve a bridge IP. Set `CONTAINER_HOST_GATEWAY`
  in `.env` as the escape hatch and check
  `container network inspect default` reports an `ipv4Gateway`.
- **A group's shared files seem to vanish inside the container.** Check the
  host error log for `Dropping nested file mount` lines — if a mount you added
  via `additionalMounts` is a FILE nested inside another mount, it was dropped
  (see apple/container#2148); mount the parent directory instead.
