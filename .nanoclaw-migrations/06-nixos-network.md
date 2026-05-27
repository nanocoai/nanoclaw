# 06 — NixOS container networking patch

> ✅ **VERIFIED** against `origin/main:src/container-runtime.ts` (90 lines total, audited in full on 2026-05-27).

## Decision

Patch the existing `hostGatewayArgs()` function in v2's `src/container-runtime.ts` to detect NixOS and return `['--network=host']` instead of `['--add-host=host.docker.internal:host-gateway']`. Then update `CONTAINER_HOST_GATEWAY` consumers to use `127.0.0.1` when NixOS. Open PR upstream with same diff. No skill, no abstraction.

## Verified v2 state (no NixOS handling exists)

`origin/main:src/container-runtime.ts:15-21`:

```ts
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}
```

Problems on NixOS:
1. `--add-host=...:host-gateway` requires the Docker daemon to know the host gateway. On NixOS this works only when the bridge network was created with `com.docker.network.host_ipv4` set — usually it isn't.
2. Even when it works, the host gateway address inside the container often doesn't route back to host services because of NixOS firewall defaults.

`--network=host` sidesteps both — the container shares the host network namespace, so `127.0.0.1` from inside the container is the host's loopback.

Note: v2's file does NOT expose a `CONTAINER_HOST_GATEWAY` constant. The hostname used by host-targeting URLs is set elsewhere (likely in `src/container-runner.ts` or env-derived). Need to grep before patching — we may need to change two places, not one.

## How to apply (Stage 1.1)

### 1. Patch `hostGatewayArgs()`

Replace the function body in `src/container-runtime.ts:15-21`:

```ts
export function hostGatewayArgs(): string[] {
  if (os.platform() === 'linux') {
    if (fs.existsSync('/etc/NIXOS')) {
      return ['--network=host'];
    }
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}
```

Plus `import fs from 'fs';` at top (only `os` is imported today, line 6).

### 2. Make any "host gateway hostname" consumers NixOS-aware

Grep before patch:

```bash
git grep -n 'host.docker.internal' origin/main -- src/
```

Wherever the literal `host.docker.internal` appears in code paths used after `hostGatewayArgs()` is applied — replace with a small helper that returns `127.0.0.1` when `--network=host` is in effect, `host.docker.internal` otherwise.

The simplest shape — add to `container-runtime.ts`:

```ts
export function hostGateway(): string {
  if (os.platform() === 'linux' && fs.existsSync('/etc/NIXOS')) {
    return '127.0.0.1';
  }
  return 'host.docker.internal';
}
```

And replace any string literal `host.docker.internal` in the container-spawn paths with `hostGateway()`.

### 3. Build + test on NixOS

```bash
pnpm run build
# spawn a session, exec into the container, confirm host reachability:
docker exec <container> curl -fsS "http://$(getent hosts host.docker.internal | awk '{print $1}'):<credential-proxy-port>/<healthz endpoint>"
# or, with --network=host:
docker exec <container> curl -fsS "http://127.0.0.1:<credential-proxy-port>/<healthz endpoint>"
```

(Exact health endpoint TBD — see [02-credentials.md](02-credentials.md) for the credential proxy port.)

### 4. PR upstream

Title: `feat(container): use --network=host and 127.0.0.1 gateway on NixOS`

Body — describe the resolution problem on NixOS + the `/etc/NIXOS` discriminator. Reference original v1 patches `fcaeb4a` and `e9337eb` for prior art on this fork.

## Notes

- The patch is ~10 lines total. Local commit = the PR diff. If upstream merges, we drop the local commit; if they ask for a different shape (e.g. env-var opt-in), we update the PR.
- `/etc/NIXOS` exists on every NixOS system — minimal and reliable discriminator. Cheaper than calling `nixos-version`.
- v2's file is **only 90 lines**, simpler than v1. Whole patch lives in this one file (plus possibly one call site in `container-runner.ts`).
