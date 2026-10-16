---
name: convert-to-podman
description: Switch from Docker Desktop to Podman as the container runtime on macOS. Installs Podman, the podman-mac-helper docker.sock shim, and a `docker` CLI symlink so NanoClaw uses Podman without any source changes. Triggers on "convert to podman", "switch to podman", "use podman instead of docker", "podman instead of docker desktop". macOS only.
---

# Convert to Podman (macOS)

This skill replaces Docker (Desktop or otherwise) with Podman as NanoClaw's container runtime.

Unlike `/convert-to-apple-container`, **no NanoClaw source changes are required**. Podman ships a docker-compatible CLI and `podman-mac-helper` installs a `/var/run/docker.sock` shim, so every `docker …` call NanoClaw makes — from `src/container-runtime.ts`, `src/container-runner.ts`, `setup/container.ts`, `container/build.sh` — transparently hits Podman.

**What this changes:**
- Installs Podman via Homebrew (if missing) and starts a podman machine sized for NanoClaw
- Installs `podman-mac-helper` so `/var/run/docker.sock` is a working Docker-compat socket
- Creates a real `/opt/homebrew/bin/docker` symlink → `podman`, so `command -v docker` and Node's `spawn('docker', …)` resolve

**What stays the same:**
- All NanoClaw source code — Dockerfile, build script, container-runtime.ts unchanged
- launchd service config

## Prerequisites

Verify macOS:

```bash
[ "$(uname -s)" = "Darwin" ] && echo "macOS confirmed" || echo "This skill is macOS-only — abort"
```

Verify Homebrew:

```bash
command -v brew >/dev/null && echo "brew ready" || echo "Install Homebrew first: https://brew.sh"
```

A shell alias like `alias docker=podman` is **not** sufficient — Node's `child_process.spawn` and `command -v docker` execute the binary directly, bypassing shell aliases.

## Phase 1: Pre-flight

### Check for Docker Desktop conflicts

```bash
ls -la /usr/local/bin/docker /opt/homebrew/bin/docker 2>/dev/null || true
pgrep -fl 'Docker Desktop|com.docker' 2>/dev/null || echo "Docker Desktop not running"
```

If Docker Desktop is running, ask the user before quitting it. NanoClaw will favour whichever `docker` binary appears first on PATH; running both daemons simultaneously is supported but wasteful.

### Check if already applied

```bash
docker info 2>/dev/null | grep -qi 'podman' && echo "Already on Podman — skip to Phase 4" || echo "Need setup"
```

## Phase 2: Install Podman

### Install via Homebrew

```bash
command -v podman >/dev/null || brew install podman
```

### Initialize and start the podman machine

NanoClaw runs multiple agent containers and rebuilds images frequently — the default machine size (2 GiB / 2 CPUs) is too small. Bump it:

```bash
podman machine list --format '{{.Name}}' | grep -q . || podman machine init --cpus 4 --memory 8192 --disk-size 60
podman machine start 2>&1 | grep -v 'already running' || true
```

If a machine already exists at the default size, resize it:

```bash
podman machine stop && podman machine set --cpus 4 --memory 8192 && podman machine start
```

Verify:

```bash
podman machine list
podman info >/dev/null && echo "Podman ready"
```

## Phase 3: Set up Docker compatibility

### Install podman-mac-helper

This is a small system service shipped with Podman. It registers a launchd helper that creates `/var/run/docker.sock` as a symlink to the running podman socket. It needs `sudo` because `/var/run` is system-owned.

```bash
ls -la /var/run/docker.sock 2>/dev/null | grep -q podman && echo "helper already installed" \
  || sudo $(brew --prefix podman)/bin/podman-mac-helper install
```

### Restart the podman machine to pick up the helper

```bash
podman machine stop && podman machine start
```

### Symlink the docker CLI

This is the step a shell alias cannot replace. Node's `child_process.spawn('docker', …)` and bash's `command -v docker` look up an actual binary — they don't see aliases.

```bash
ln -sf $(brew --prefix podman)/bin/podman $(brew --prefix)/bin/docker
```

If `/usr/local/bin/docker` exists from a Docker Desktop install and might shadow this on PATH, either uninstall Docker Desktop (`brew uninstall --cask docker`) or move the binary aside:

```bash
[ -e /usr/local/bin/docker ] && [ ! -L /usr/local/bin/docker ] \
  && sudo mv /usr/local/bin/docker /usr/local/bin/docker.docker-desktop.bak \
  || true
```

Verify the new `docker` resolves to podman:

```bash
which docker
docker --version
```

Expected: `/opt/homebrew/bin/docker` and a `podman version …` string.

## Phase 4: Verify

### Sanity-check the docker compat layer

```bash
docker info | head -30
docker version
ls -la /var/run/docker.sock
```

`docker info` should report Podman details (look for `BuildahVersion` or `Server: Podman Engine`). The socket should be a symlink into `~/.local/share/containers/podman/machine/`.

### Build the NanoClaw image

```bash
./container/build.sh
```

The build should complete using podman's BuildKit-compatible build engine. Cache mounts (`--mount=type=cache`) in the Dockerfile are supported on Podman 4.0+.

### Smoke-test container execution

```bash
docker run --rm --entrypoint /bin/echo nanoclaw-agent:latest "Podman container OK"
```

Test a readonly mount. Use a path under `/Users` — Podman's VM mounts `/Users`, `/private`, and `/var/folders` from the host via virtiofs, but `/tmp` inside the VM is a separate tmpfs and is **not** shared with the host's `/tmp`:

```bash
mkdir -p ./.podman-test && echo "hello" > ./.podman-test/file.txt
docker run --rm --entrypoint /bin/bash \
  -v "$(pwd)/.podman-test:/test:ro" \
  nanoclaw-agent:latest \
  -c "cat /test/file.txt && (touch /test/new.txt 2>&1 || echo 'Write blocked (expected)')"
rm -rf ./.podman-test
```

Expected: read succeeds, write reports "Read-only file system". NanoClaw's session DBs live under the project directory (which is under `/Users`), so they're visible inside the VM by default.

Test `host.docker.internal` (NanoClaw adds this on Linux only, but it's worth confirming Podman doesn't break the macOS path):

```bash
docker run --rm --add-host=host.docker.internal:host-gateway --entrypoint /bin/bash \
  nanoclaw-agent:latest \
  -c "getent hosts host.docker.internal || echo 'gateway not resolved'"
```

### Run the host test suite

```bash
pnpm test
pnpm run build
```

Tests should pass unchanged — no source has been modified.

### Full integration test (only if NanoClaw is installed as a service)

```bash
launchctl list | grep -q com.nanoclaw && launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Tail logs and confirm no docker-related errors:

```bash
tail -50 logs/nanoclaw.error.log logs/nanoclaw.log 2>/dev/null
```

Send a message via your wired channel and confirm the agent container spawns under Podman:

```bash
docker ps --filter label=nanoclaw-install
```

## Troubleshooting

**`docker info` errors with "Cannot connect to the Docker daemon":**
- Podman machine isn't running: `podman machine start`
- Helper isn't installed or socket is stale: `sudo $(brew --prefix podman)/bin/podman-mac-helper install` then `podman machine stop && podman machine start`

**`/var/run/docker.sock` doesn't exist:**
- Verify the helper plist is loaded: `sudo launchctl list | grep -i podman`
- The plist lives at `/Library/LaunchDaemons/com.github.containers.podman.helper-$USER.plist`

**BuildKit cache mounts fail:**
- Podman 4.0+ supports the syntax. Check version: `podman --version`. If older, `brew upgrade podman`.

**Container build hangs at `pnpm install` (or any npm-registry step) when OneCLI is in use:**
- Podman defaults to `--http-proxy=true`, which auto-injects host `HTTPS_PROXY` into builds. If OneCLI's gateway is the proxy, the container hits `registry.npmjs.org` via the OneCLI MITM, which presents a CA-signed cert the container doesn't trust. `pnpm install` retries silently and hangs forever (no error, no CPU). Worse: the proxy is **captured at `podman machine start` time** and persists; unsetting `HTTPS_PROXY` in your shell at build invocation does **not** clear it.
- Symptom: `STEP N/M: RUN ... pnpm install ...` shows `Progress: resolved 0, reused 1, downloaded 0` then never advances. `pgrep -af pnpm` inside the VM shows the process at 0% CPU with zero open sockets.
- Fix: pass `--http-proxy=false` to `podman build`. To do this with `container/build.sh`, either patch the script or invoke podman directly:
  ```
  cd container && podman build --http-proxy=false -t <image>:latest .
  ```
- Alternative: `HTTPS_PROXY= HTTP_PROXY= podman machine restart` to clear the captured env (briefly takes the OneCLI compose stack offline; it auto-recovers).

**Mount errors with `statfs … no such file or directory` for `/tmp/...` paths:**
- Podman's VM mounts the host's `/Users`, `/private`, and `/var/folders` via virtiofs, but `/tmp` inside the VM is a separate tmpfs. Move the data under `/Users` (or one of the mounted paths). NanoClaw's defaults already comply.

**Slow image builds or "no space left on device":**
- The podman machine VM is too small. Stop, resize, restart:
  `podman machine stop && podman machine set --cpus 6 --memory 12288 --disk-size 100 && podman machine start`

**Existing `/usr/local/bin/docker` from Docker Desktop wins on PATH:**
- Even though `/opt/homebrew/bin` is usually first, some shells/services may have `/usr/local/bin` first. Either uninstall Docker Desktop (`brew uninstall --cask docker`) or move its binary aside (see Phase 3).

**`docker compose` commands needed:**
- NanoClaw itself does not run `docker compose`. If a separate tool needs it, install `podman-compose` (`brew install podman-compose`) or `docker compose` v2 standalone.

## Summary of Changes

| Action | Result |
|--------|--------|
| `brew install podman` | Installs Podman + `podman-mac-helper` |
| `podman machine init --cpus 4 --memory 8192 --disk-size 60` | Creates the Linux VM |
| `sudo podman-mac-helper install` | Creates `/var/run/docker.sock` shim |
| `ln -sf … podman docker` in `$(brew --prefix)/bin` | Provides a real `docker` binary on PATH |

No NanoClaw source code is modified — Podman's docker compatibility handles every CLI call, socket reference, and Dockerfile feature NanoClaw uses.
