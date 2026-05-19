---
name: add-mnemon
description: Add persistent graph-based memory via mnemon. Agents recall past context before responding and remember insights after each turn.
---

# Add Mnemon — Persistent Memory

Installs [mnemon](https://github.com/mnemon-dev/mnemon) in the agent container image. On each container start, `mnemon setup` registers Claude Code hooks that surface relevant memory before the agent responds and store new insights after each turn. Memory is written to the per-agent-group `.claude/` mount and survives container restarts.

## Provider Compatibility

**mnemon hooks only work with `--target claude-code`.** If the agent group uses `AGENT_PROVIDER=opencode`, hooks registered by `mnemon setup` will never fire — OpenCode spawns its own process and doesn't invoke the `claude` CLI at all.

Check your provider:

```bash
grep AGENT_PROVIDER .env groups/*/container.json 2>/dev/null
```

- `AGENT_PROVIDER=claude` (default) — fully compatible, proceed with both Phase 2 steps.
- `AGENT_PROVIDER=opencode` — use **Phase 2 (OpenCode path)** instead of the standard entrypoint step.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q 'MNEMON_VERSION' container/Dockerfile && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Verify).

### Check latest mnemon version

```bash
curl -fsSL https://api.github.com/repos/mnemon-dev/mnemon/releases/latest | grep '"tag_name"'
```

Note the version (e.g. `v0.1.1`) — use it as `MNEMON_VERSION` in the next step.

## Phase 2: Apply Changes (Claude Code path)

### 1. Dockerfile — install mnemon binary

Add after the AWS CLI block, before the Bun runtime section:

```dockerfile
# ---- mnemon — persistent agent memory ----------------------------------------
ARG MNEMON_VERSION=0.1.1
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/mnemon-dev/mnemon/releases/download/v${MNEMON_VERSION}/mnemon_${MNEMON_VERSION}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin mnemon && \
    chmod +x /usr/local/bin/mnemon

ENV MNEMON_DATA_DIR=/home/node/.claude/mnemon
```

`MNEMON_DATA_DIR` points into the per-agent-group `.claude/` mount so memory persists across container restarts. No extra volume mounts needed.

### 2. Entrypoint — run mnemon setup on each container start

`mnemon setup` is idempotent. Edit `container/entrypoint.sh` to run it right after `set -e`, before the `cat` that captures stdin:

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

### 3. Rebuild and smoke-test the image

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

## Phase 2 (OpenCode path) — context injection

mnemon hooks don't fire under OpenCode. Instead, the agent-runner injects mnemon context directly into every prompt via `wrapPromptWithContext()` in `container/agent-runner/src/providers/opencode.ts`. This is already implemented in NanoClaw — no code changes needed if you're on current `ester`/`main`.

**How it works:** On each prompt, `readMnemonContext()` checks for `MNEMON_DATA_DIR` (set by the Dockerfile `ENV`). If the env var is present, it reads `$MNEMON_DATA_DIR/prompt/guide.md` (mnemon's custom prompt guide, written by `mnemon setup`) or falls back to an inline guide. The content is prepended as a `<system>` block, instructing the agent to run `mnemon recall` at the start of relevant tasks and `mnemon remember` after key decisions.

**What this means for the agent:** The agent (running inside OpenCode) can call `mnemon recall`, `mnemon remember`, `mnemon link`, and `mnemon status` via its bash tool. mnemon writes its graph to `$MNEMON_DATA_DIR`, which is in the per-agent-group `.claude/` mount — so memory persists across container restarts.

**Applying:** Only the Dockerfile step from Phase 2 is needed for OpenCode agents. Skip `container/entrypoint.sh` entirely.

```dockerfile
ARG MNEMON_VERSION=0.1.1
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/mnemon-dev/mnemon/releases/download/v${MNEMON_VERSION}/mnemon_${MNEMON_VERSION}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin mnemon && \
    chmod +x /usr/local/bin/mnemon
ENV MNEMON_DATA_DIR=/home/node/.claude/mnemon
```

Then rebuild: `./container/build.sh`

### Verify (OpenCode)

Start a session and ask the agent to run `mnemon status`. It should report empty graphs (no error) on first run.

```bash
# Also confirm the binary is present in the image:
docker run --rm --entrypoint mnemon nanoclaw-agent:latest --version
```

## Memory Storage

Mnemon writes to `/home/node/.claude/mnemon/` inside the container, which maps to the per-agent-group `.claude/` directory on the host. To find the exact host path:

```bash
docker inspect $(docker ps --filter name=nanoclaw-v2 --format '{{.Names}}' | head -1) \
  --format '{{range .Mounts}}{{if eq .Destination "/home/node/.claude"}}{{.Source}}{{end}}{{end}}'
```

To reset all memory for an agent, stop the container and delete the `mnemon/` subdirectory from that host path.

## Migration Guide Update

If you are using `/migrate-nanoclaw`, add these entries to `.nanoclaw-migrations/05-dockerfile.md`:

**Dockerfile — after AWS CLI, before Bun runtime:**
```dockerfile
ARG MNEMON_VERSION=0.1.1
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/mnemon-dev/mnemon/releases/download/v${MNEMON_VERSION}/mnemon_${MNEMON_VERSION}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin mnemon && \
    chmod +x /usr/local/bin/mnemon
ENV MNEMON_DATA_DIR=/home/node/.claude/mnemon
```

**`container/entrypoint.sh` — add after `set -e`:**
```bash
mnemon setup --target claude-code --yes --global >/dev/stderr 2>&1
```

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
