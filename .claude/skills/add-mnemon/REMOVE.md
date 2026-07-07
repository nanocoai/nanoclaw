# Remove Mnemon

Every step is idempotent — safe to run even if some steps were never applied.

## 1. Strip the Dockerfile install layer

Open `container/Dockerfile` and delete the mnemon block (the `# ---- mnemon` comment, the `ARG MNEMON_VERSION`, the `RUN` that downloads the binary, and the `ENV MNEMON_DATA_DIR` line):

```dockerfile
# ---- mnemon — persistent agent memory ----------------------------------------
ARG MNEMON_VERSION=0.1.1
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/mnemon-dev/mnemon/releases/download/v${MNEMON_VERSION}/mnemon_${MNEMON_VERSION}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin mnemon && \
    chmod +x /usr/local/bin/mnemon

ENV MNEMON_DATA_DIR=/home/node/.claude/mnemon
```

If the block is already gone, skip this step.

## 2. Strip the entrypoint setup line

Open `container/entrypoint.sh` and delete the `mnemon setup` line that follows `set -e`:

```bash
mnemon setup --target claude-code --yes --global >/dev/stderr 2>&1
```

If the line is already gone, skip this step.

## 3. Delete the copied test files

```bash
rm -f src/mnemon-dockerfile.test.ts src/mnemon-entrypoint.test.ts
```

## 4. Rebuild and restart

```bash
pnpm run build && ./container/build.sh
source setup/lib/install-slug.sh

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)

# Linux
systemctl --user restart $(systemd_unit)
```

## 5. Delete stored memory (optional)

Mnemon's graph lives at `/home/node/.claude/mnemon/` in each container, which maps to the per-agent-group `.claude/` directory on the host. To find the host path and clear it:

```bash
docker inspect $(docker ps --filter name=nanoclaw-v2 --format '{{.Names}}' | head -1) \
  --format '{{range .Mounts}}{{if eq .Destination "/home/node/.claude"}}{{.Source}}{{end}}{{end}}'
```

Stop the container, then delete the `mnemon/` subdirectory from that path.
