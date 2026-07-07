---
name: add-mnemon
description: Add persistent graph-based memory via mnemon. Agents recall past context before responding and remember insights after each turn.
---

# Add Mnemon — Persistent Memory

Installs [mnemon](https://github.com/mnemon-dev/mnemon) in the agent container image. On each container start, `mnemon setup` registers Claude Code hooks that surface relevant memory before the agent responds and store new insights after each turn. Memory is written to the per-agent-group `.claude/` mount and survives container restarts.

## Provider Compatibility

mnemon hooks fire only under `--target claude-code`. Use this skill on agent groups that run the default Claude provider. The provider is the materialized `provider` key in each group's `container.json` (absent or `claude` = default Claude provider). Confirm it before applying:

```bash
grep -H '"provider"' groups/*/container.json 2>/dev/null   # no match, or "provider": "claude" = Claude
```

If a group sets a different provider (e.g. `"provider": "opencode"`), it spawns its own process and never invokes the `claude` CLI, so the hooks registered by `mnemon setup` do not run for that group.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q 'MNEMON_VERSION' container/Dockerfile && echo "Already applied" || echo "Not applied"
```

If already applied, re-run Phase 2 anyway — every step is idempotent and skips work that is already in place — then continue to Phase 3 (Verify).

### Check latest mnemon version

```bash
curl -fsSL https://api.github.com/repos/mnemon-dev/mnemon/releases/latest | grep '"tag_name"'
```

Note the version (e.g. `v0.1.1`) — use it as `MNEMON_VERSION` in the next step.

## Phase 2: Apply Changes

### 1. Dockerfile — install mnemon binary

Insert the mnemon block immediately above the `# ---- Bun runtime` section of `container/Dockerfile` (skip if `grep -q 'MNEMON_VERSION' container/Dockerfile` already matches):

```dockerfile
# ---- mnemon — persistent agent memory ----------------------------------------
ARG MNEMON_VERSION=0.1.1
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/mnemon-dev/mnemon/releases/download/v${MNEMON_VERSION}/mnemon_${MNEMON_VERSION}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin mnemon && \
    chmod +x /usr/local/bin/mnemon

ENV MNEMON_DATA_DIR=/home/node/.claude/mnemon
```

`MNEMON_DATA_DIR` points into the per-agent-group `.claude/` mount, so memory persists across container restarts.

### 2. Entrypoint — run mnemon setup on each container start

`mnemon setup` is idempotent. Run it once per `container/entrypoint.sh`. First check whether the line is already present:

```bash
grep -q 'mnemon setup' container/entrypoint.sh && echo "Already wired" || echo "Wire it"
```

If it prints `Wire it`, add the setup call right after `set -e`, before the `cat` that captures stdin, so the result looks like:

```bash
#!/bin/bash
# NanoClaw agent container entrypoint.
#
# ...existing header comment...

set -e

mnemon setup --target claude-code --yes --global >/dev/stderr 2>&1

cat > /tmp/input.json

exec bun run /app/src/index.ts < /tmp/input.json
```

`>/dev/stderr 2>&1` routes all mnemon output to stderr (docker logs) so it doesn't interfere with the JSON stdin handshake between host and agent-runner.

### 3. Copy the integration tests

Both reach-ins are into container build/runtime files that aren't importable or typed (a GitHub-release binary in the Dockerfile, a shell line in the entrypoint), so structural tests guard them. Copy them into the host test tree:

```bash
cp .claude/skills/add-mnemon/mnemon-dockerfile.test.ts src/mnemon-dockerfile.test.ts
cp .claude/skills/add-mnemon/mnemon-entrypoint.test.ts src/mnemon-entrypoint.test.ts
pnpm exec vitest run src/mnemon-dockerfile.test.ts src/mnemon-entrypoint.test.ts
```

`mnemon-dockerfile.test.ts` asserts the `MNEMON_VERSION` ARG and `MNEMON_DATA_DIR` ENV are present (red if the install layer is dropped on an upgrade). `mnemon-entrypoint.test.ts` asserts the entrypoint invokes `mnemon setup --target claude-code` (red if the wiring is removed).

### 4. Rebuild and smoke-test the image

```bash
./container/build.sh
docker run --rm --entrypoint mnemon nanoclaw-agent:latest --version
```

## Phase 3: Restart and Verify

### Restart the service

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
```

### Confirm mnemon hooks are registered

After the next container starts, check that setup ran:

```bash
docker logs $(docker ps --filter name=nanoclaw-v2 --format '{{.Names}}' | head -1) 2>&1 | grep -i mnemon
```

Then inspect the hooks inside the running container:

```bash
docker exec $(docker ps --filter name=nanoclaw-v2 --format '{{.Names}}' | head -1) \
  cat /home/node/.claude/settings.json | grep -A5 mnemon
```

### Test memory recall

Have a conversation with the agent, then start a new session and reference something from the earlier one. Mnemon should surface the relevant context automatically without you restating it.

## Memory Storage

Mnemon writes to `/home/node/.claude/mnemon/` inside the container, which maps to the per-agent-group `.claude/` directory on the host. To find the exact host path:

```bash
docker inspect $(docker ps --filter name=nanoclaw-v2 --format '{{.Names}}' | head -1) \
  --format '{{range .Mounts}}{{if eq .Destination "/home/node/.claude"}}{{.Source}}{{end}}{{end}}'
```

To reset all memory for an agent, stop the container and delete the `mnemon/` subdirectory from that host path.

## Troubleshooting

### `mnemon: command not found` in container

The image wasn't rebuilt after adding the Dockerfile layer. Run `./container/build.sh` and restart.

### Memory not persisting across restarts

Verify `MNEMON_DATA_DIR` resolves to a mounted path (not an in-container ephemeral directory):

```bash
docker exec <container> sh -c 'ls -la $MNEMON_DATA_DIR'
```

If the directory is empty after conversations, the mount is missing or the path is wrong. Check the host mount with the `docker inspect` command above.

### Agent not using past memory

`mnemon setup` writes hooks into `/home/node/.claude/settings.json`. Verify:

```bash
docker exec <container> cat /home/node/.claude/settings.json
```

If the hooks are absent, `mnemon setup` may have failed silently. Check container startup logs for errors from mnemon.

### Setup fails at container start

Run setup manually inside a running container to see the full error:

```bash
docker exec -it <container> mnemon setup --target claude-code --yes --global
```
