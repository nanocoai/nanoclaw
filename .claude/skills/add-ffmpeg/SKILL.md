---
name: add-ffmpeg
description: Add ffmpeg as an MCP tool so the agent can convert, trim, extract audio from, and compress media files (mp4, mp3, wav, mov, webm, etc.) and send the result back to the channel. Wraps the ffmpeg/ffprobe binaries as a stdio MCP server; no third-party npm package, no credentials, no sidecar.
---

# Add ffmpeg

Patches `container/Dockerfile` to install `ffmpeg` + `ffprobe` (~80MB), wires the in-repo `container/agent-runner/src/ffmpeg-mcp/server.ts` MCP server into selected agent groups, and rebuilds. After install the agent can transform an inbound media attachment and reply with the result via `mcp__nanoclaw__send_file`.

The trunk container image ships **without** ffmpeg — it's added only when this skill runs. There is no `INSTALL_FFMPEG` env flag; the patch is a real Dockerfile edit so it survives `./container/build.sh` and `pnpm run dev` invocations consistently.

Tools surfaced as `mcp__ffmpeg__<name>`:

| Tool | What it does |
|------|---------------|
| `probe` | ffprobe metadata: duration, format, per-stream codec/size info |
| `convert` | Change format/container (mp4 ↔ mp3 ↔ wav ↔ mov ↔ webm, etc.) |
| `trim` | Cut a `[start, start+duration)` segment |
| `extract_audio` | Strip the audio track from a video |
| `compress` | Re-encode for size, by CRF or rough target MB |

## Phase 1: Pre-flight

```bash
grep -q '# ---- ffmpeg' container/Dockerfile && echo "ALREADY PATCHED — skip to Phase 3"
test -f container/agent-runner/src/ffmpeg-mcp/server.ts || echo "MISSING ffmpeg-mcp server source — pull the branch that ships it"
```

## Phase 2: Patch the Dockerfile and rebuild

Use the Edit tool to insert a new RUN block into `container/Dockerfile` immediately before the `# Chromium path for agent-browser ...` ENV line (i.e. right after the system-deps `apt-get` block). Insert exactly:

```dockerfile
# ---- ffmpeg (added by /add-ffmpeg) -----------------------------------------
# ffmpeg + ffprobe (~80MB). Used by the ffmpeg-mcp MCP server so the agent
# can convert/trim/extract-audio/compress inbound media files. Remove this
# block to revert (`/add-ffmpeg` removal section).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

```

The leading `# ---- ffmpeg` marker is the idempotency anchor — re-running the skill on a patched Dockerfile is a no-op.

Then rebuild:

```bash
./container/build.sh
```

Verify (the image tag is install-slug-derived and printed at the end of `build.sh`; `--entrypoint sh` is required so the agent-runner entrypoint doesn't intercept):

```bash
IMAGE=$(docker images --filter 'reference=nanoclaw-agent*:latest' --format '{{.Repository}}:{{.Tag}}' | head -1)
docker run --rm --entrypoint sh "$IMAGE" -c 'which ffmpeg && ffmpeg -version | head -1'
```

## Phase 3: Wire per-agent-group

For each group that should be able to transform media, merge into `groups/<folder>/container.json`:

```jsonc
{
  "mcpServers": {
    "ffmpeg": {
      "command": "bun",
      "args": ["run", "/app/src/ffmpeg-mcp/server.ts"],
      "env": {}
    }
  }
}
```

No `additionalMounts`, no credentials. Inputs are read from `/workspace/inbox/...` (already mounted) or from a prior tool's output under `/tmp`; outputs go to `/tmp/ffmpeg-<uuid>.<ext>`. `/tmp` is container-internal (not bind-mounted), so outputs auto-clean on container exit and don't accumulate on the host.

Within a long-running container, outputs are still reaped on a periodic timer (default: files older than 15 min, swept every 5 min) plus a startup sweep — relevant for chains like trim → compress → extract_audio that produce intermediates in a single session.

Optional env overrides (default 5 min per-call timeout, 15 min tmp TTL, 5 min sweep cadence):

```jsonc
"env": {
  "NANOCLAW_FFMPEG_TIMEOUT_SEC": "900",      // global default per-call timeout
  "NANOCLAW_FFMPEG_TMP_TTL_SEC": "900",      // tmp file lifetime before sweep
  "NANOCLAW_FFMPEG_TMP_SWEEP_SEC": "300"     // sweep interval
}
```

Each tool also accepts a per-call `timeout_seconds` arg (range 5–1800) — useful when a single long convert needs more time than the group default. The ffmpeg process is `SIGKILL`ed on expiry so a hung encoder can't block the MCP transport.

## Phase 4: Restart

```bash
pnpm run build
systemctl --user restart nanoclaw  # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```

## Phase 5: Verify

In a wired chat, send a short `.mp4` with **"convert to mp3"** — you should receive an `.mp3` back. Other prompts to try: **"what's the duration"** (probe), **"give me seconds 5–15"** (trim), **"strip the audio"** (extract_audio).

If something's off:

```bash
tail -200 logs/nanoclaw.log logs/nanoclaw.error.log | grep -F '[ffmpeg-mcp]'
```

Every failure path emits `[ffmpeg-mcp] ERROR <tool>: <reason>`, routed to `log.error` by `src/container-runner.ts`, so it appears at the default `info` threshold.

Common signals:
- `command not found: ffmpeg` → image wasn't rebuilt after the Dockerfile patch. Re-run `./container/build.sh`.
- `Input path must live under /workspace` → tell the agent to operate on `/workspace/inbox/...`.
- `Unsupported output_format` → check `OUTPUT_EXT_WHITELIST` in `server.ts`.
- `ffmpeg failed: ...` → the line includes the last 200 chars of ffmpeg's stderr; usually the input isn't valid media.
- Agent says "I don't have ffmpeg tools" → group's `container.json` is missing the `mcpServers.ffmpeg` entry, or the host wasn't restarted.

## Removal

1. Delete the `"ffmpeg"` entry from `mcpServers` in each group's `container.json`.
2. Edit `container/Dockerfile` and remove the `# ---- ffmpeg (added by /add-ffmpeg) ---` block (the comment header through the trailing blank line).
3. `./container/build.sh && pnpm run build && systemctl --user restart nanoclaw`.
