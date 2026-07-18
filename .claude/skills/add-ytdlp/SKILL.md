---
name: add-ytdlp
description: Add yt-dlp as an MCP tool so the agent can search YouTube, fetch metadata, and download video/audio from YouTube, Vimeo, X, TikTok, and ~1000 other sites. Patches `container/Dockerfile` to install the standalone yt-dlp binary and wires the in-tree `yt-dlp-mcp` server into selected agent groups.
---

# Add yt-dlp

Patches `container/Dockerfile` to install `yt-dlp` (~30MB) and wires the in-tree MCP server at `container/agent-runner/src/yt-dlp-mcp/` into selected agent groups as a stdio MCP server. After install the agent can take a URL the user shares and reply with the file via `mcp__nanoclaw__send_file`, or with metadata/search results inline.

The trunk container image ships **without** yt-dlp — it's added only when this skill runs. The patch is a real Dockerfile edit so it survives `./container/build.sh` and `pnpm run dev` invocations consistently.

The MCP server itself is in-tree (lives in this repo at `container/agent-runner/src/yt-dlp-mcp/`), spawned by Bun directly from the bind-mounted source — no npm dependency, no separate publish step. It's a thin wrapper over the yt-dlp CLI with a curated four-tool surface tuned for chat agents.

Tools surfaced as `mcp__yt-dlp__<name>`:

| Tool | What it does |
|------|---------------|
| `ytdlp_search` | YouTube search with pagination, filters (`minDuration` / `maxDuration` / `minViews`), sort (`relevance` / `date` / `views`), JSON or markdown output, and a `maxChars` cap. |
| `ytdlp_get_metadata` | Full yt-dlp JSON for a URL, or a compact human-readable summary if `summary: true`. `maxChars` cap. |
| `ytdlp_download_video` | Default: mp4 at chosen resolution (`480p`/`720p`/`1080p`/`best`). Fallback on failure: best quality in any container. Optional `trim: { start, end }`. |
| `ytdlp_download_audio` | Default: mp3 (transcoded — needs ffmpeg on PATH). Fallback on failure: best native audio (no transcoding). |

Downloads land in `$YTDLP_DOWNLOADS_DIR` (defaults below to `/tmp`), so the agent can hand the resulting path straight to `mcp__nanoclaw__send_file`. `/tmp` is container-internal (not bind-mounted), so files evaporate cleanly on container exit — no host clutter to sweep.

## Phase 1: Pre-flight

```bash
grep -q '# ---- yt-dlp' container/Dockerfile && echo "DOCKERFILE ALREADY PATCHED — skip Phase 2"
```

## Phase 2: Patch the Dockerfile and rebuild

Use the Edit tool to insert a new RUN block into `container/Dockerfile` immediately before the `# Chromium path for agent-browser ...` ENV line (i.e. right after the system-deps `RUN ... apt-get install ...` block). Insert exactly:

```dockerfile
# ---- yt-dlp (added by /add-ytdlp) ---------------------------------
# Standalone PyInstaller-bundled Linux binary from the upstream GitHub release
# (~30MB). No apt package, no Python on PATH required. Used by the in-tree
# yt-dlp-mcp server at /app/src/yt-dlp-mcp/. The --version smoke-test fails
# the build if the download is corrupt or the tag was retracted. Bump
# deliberately. Replace <tag> with the N-1 tag in the releases page.
ARG YTDLP_VERSION=<tag>
RUN curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" \
         -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --version

```

The leading `# ---- yt-dlp` marker is the idempotency anchor — re-running the skill on a patched Dockerfile is a no-op.

Then rebuild:

```bash
./container/build.sh
```

Verify (the image tag is install-slug-derived and printed at the end of `build.sh`; `--entrypoint sh` is required so the agent-runner entrypoint doesn't intercept):

```bash
IMAGE=$(docker images --filter 'reference=nanoclaw-agent*:latest' --format '{{.Repository}}:{{.Tag}}' | head -1)
docker run --rm --entrypoint sh "$IMAGE" -c 'yt-dlp --version && echo OK'
```

Expect a yt-dlp date version (e.g. `2026.03.17`) followed by `OK`.

## Phase 3: Wire per-agent-group

For each group that should get yt-dlp capability, merge into `groups/<folder>/container.json`:

```jsonc
{
  "mcpServers": {
    "yt-dlp": {
      "command": "bun",
      "args": ["run", "/app/src/yt-dlp-mcp/server.ts"],
      "env": {
        "YTDLP_DOWNLOADS_DIR": "/tmp",
        "NO_PROXY": "*",
        "no_proxy": "*"
      }
    }
  }
}
```

`YTDLP_DOWNLOADS_DIR` redirects downloads to `/tmp`, which is container-internal (not bind-mounted from the host), so the session container is the only place these files ever exist — they vanish when the container exits with `--rm`. `send_file` copies the bytes into `/workspace/outbox/<msg-id>/` before delivery, so downloads don't need to outlive the container.

`NO_PROXY=*` makes yt-dlp bypass OneCLI's HTTPS_PROXY for every host. Without it, OneCLI intercepts YouTube traffic with its self-signed CA, and yt-dlp rejects the cert because its standalone PyInstaller binary uses certifi's *bundled* CA store — which lives inside the binary and ignores `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` / `CURL_CA_BUNDLE`. There's no env-var path to teach this binary to trust OneCLI's CA; only `--ca-certificate` (CLI flag) or `--no-check-certificate` would work. Bypassing the proxy is the right call anyway: yt-dlp is fetching public video from YouTube/Vimeo/etc., not a credentialed API, so there's nothing for OneCLI to inject. Both upper and lower case are set because Python's stdlib checks `NO_PROXY` while some libraries check `no_proxy`.

If the group should be allowed to read private / age-gated YouTube content, mount a cookie file and pass `--cookies` via the yt-dlp CLI — that's a separate decision and out of scope for this skill.

## Phase 4: Restart

```bash
pnpm run build
systemctl --user restart nanoclaw  # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```

## Phase 5: Verify

In a wired chat, send a YouTube link with **"download this"** — you should get the video file back as mp4. Other prompts to try: **"summarize the metadata for this video"** (`ytdlp_get_metadata` with `summary: true`), **"search for lofi study mix top 5"** (`ytdlp_search`), **"audio only as mp3"** (`ytdlp_download_audio`).

If something's off:

```bash
tail -200 logs/nanoclaw.log logs/nanoclaw.error.log | grep -F 'yt-dlp'
```

Common signals:
- `command not found: yt-dlp` → image wasn't rebuilt after the Dockerfile patch. Re-run `./container/build.sh`.
- `Cannot find module '/app/src/yt-dlp-mcp/server.ts'` → the agent-runner source bind mount is missing or the path drifted. Confirm the files exist under `container/agent-runner/src/yt-dlp-mcp/` on the host.
- Agent says "I don't have download tools" → group's `container.json` is missing the `mcpServers["yt-dlp"]` entry, or the host wasn't restarted.
- Download succeeds but `mcp__nanoclaw__send_file` fails to find the file → check `YTDLP_DOWNLOADS_DIR` matches what `send_file` is given. Default `/tmp` is the safe choice (container-internal, auto-cleaned on container exit).
- mp3 audio comes back as `.m4a`/`.webm` instead → ffmpeg isn't on PATH inside the container, so `ytdlp_download_audio` took the native fallback. Install ffmpeg in the image to enable transcoding (the tool reports `fallback: true` in its result so the agent knows it happened).
- `CERTIFICATE_VERIFY_FAILED` / `SSL: certificate verify failed` (even on plain YouTube URLs) → `NO_PROXY=*` from Phase 3 isn't in the env. OneCLI's gateway is intercepting HTTPS with its self-signed CA, and the standalone yt-dlp binary uses certifi's bundled CA store (inside the PyInstaller binary, *not* the system store), so it has no way to trust OneCLI's CA. The fix is to bypass the proxy entirely, not to teach yt-dlp the cert. Re-check the `env` block has both `NO_PROXY` and `no_proxy` set to `*`.

## Removal

1. Delete the `"yt-dlp"` entry from `mcpServers` in each group's `container.json`.
2. Edit `container/Dockerfile` and remove the `# ---- yt-dlp (added by /add-ytdlp) ---` block (the comment header through the trailing blank line).
3. `./container/build.sh && pnpm run build && systemctl --user restart nanoclaw`.

(The in-tree MCP source under `container/agent-runner/src/yt-dlp-mcp/` is left in place — it's harmless without the binary and the `mcpServers` entry. Delete that directory too if you want a clean tree.)
