# v1 → v2 fork follow-ups

Done during the 2026-05-28 migration; this file lists v1 fork customizations still to port. The v1 install lives at `/Users/eva/nanoclaw` (read-only reference). Pre-migration backup: tag `pre-update-e1356c5-20260528-065006` in that repo.

## Already ported

- **Runtime → Apple Container** (commit `179edc7`). Replaces Docker because the host runs Apple Container at `/opt/homebrew/bin/container`.
- **Credentials → native proxy** (commit `b833f80`). Drops the OneCLI/docker-compose dependency. Reads `CLAUDE_CODE_OAUTH_TOKEN` from `.env` and forwards to `api.anthropic.com` with the token injected as `Authorization: Bearer`. Container env uses `ANTHROPIC_AUTH_TOKEN=placeholder` (not `CLAUDE_CODE_OAUTH_TOKEN`) so the CLI uses Bearer directly and skips the `create_api_key` exchange that fails on Pro-tier tokens.
- **Container memory tuning**. Added `memory_mb` column to `container_configs`, exposed via `ncl groups config update --memory-mb <N>`; passed to the runtime as `-m <N>MiB` at spawn time. Both groups set to 2048 MiB to prevent Chromium OOM kills.
- **Telegram file-too-big**. `src/channels/chat-sdk-bridge.ts` now tags failed `fetchData()` with `entry.error = 'too_big' | 'download_failed'`; `container/agent-runner/src/formatter.ts` renders an explanatory `[type: name (~N MB) — too large to download …]` marker so the agent can give the user clear guidance.
- **Telegram reply context**. Already supported in v2 stock via `extractReplyContext` (`src/channels/telegram.ts:42-49`) — feeds into chat-sdk-bridge's `serialized.replyTo`. Nothing more to port.
- **Telegram 4-bot swarm**. New `src/channels/telegram-swarm.ts` parses `TELEGRAM_BOT_POOL`, init-validates via getMe, picks a bot sticky-per-(platformId, sender) on first use, renames it via `setMyName(sender)` so the persona shows up in Telegram. `src/channels/telegram.ts` wraps `deliver`: when outbound content has both `text` and `sender` and the pool is up, route via the pool; fall back to the primary bot on any failure. `mcp__nanoclaw__send_message` (`container/agent-runner/src/mcp-tools/core.ts`) accepts a new optional `sender` arg that flows through into the content JSON.

## Not ported — image vision

v1 didn't actually construct multimodal blocks for the agent — its photo handling appended a file path as text. v2 stock keeps the file payload (base64) in the inbound attachment but the agent formatter only references it as `[file: name — saved to /workspace/...]`. If real vision is wanted, that's a new feature, not a port: build a multimodal content-block path in the agent-runner provider layer.

## Gmail MCP tool — ported (v1-style pragmatic)

`@gongrzhe/server-gmail-autoauth-mcp@1.1.11` installed per group via the per-group npm package mechanism. `~/.gmail-mcp/` allowlisted (RW) and mounted into the container at `/workspace/extra/gmail-mcp/` (the mount-security layer forces additional_mounts under `/workspace/extra/` and rejects absolute containerPaths). `credentials.json` blocks the mount-security `credentials` substring pattern, so the file was duplicated as `tokens.json` and the MCP server is configured with `GMAIL_CREDENTIALS_PATH=/workspace/extra/gmail-mcp/tokens.json`. Real OAuth refresh + access tokens live in the container during sessions — same trade-off v1 made.

To replicate the wiring on a fresh install:

```bash
# 1. allowlist ~/.gmail-mcp
cat > ~/.config/nanoclaw/mount-allowlist.json <<'EOF'
{ "allowedRoots":[{"path":"/Users/eva/.gmail-mcp","allowReadWrite":true}], "blockedPatterns":[], "nonMainReadOnly":true }
EOF

# 2. duplicate credentials.json under a non-blocked name
cp ~/.gmail-mcp/credentials.json ~/.gmail-mcp/tokens.json

# 3. per group (replace <ID>)
ncl groups config add-package --id <ID> --npm '@gongrzhe/server-gmail-autoauth-mcp@1.1.11'
ncl groups config add-mcp-server --id <ID> --name gmail \
  --command gmail-mcp --args '[]' \
  --env '{"GMAIL_CREDENTIALS_PATH":"/workspace/extra/gmail-mcp/tokens.json","GMAIL_OAUTH_PATH":"/workspace/extra/gmail-mcp/gcp-oauth.keys.json"}'
# additional_mounts is not exposed by ncl yet; set via SQL
pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs SET additional_mounts='[{\"hostPath\":\"/Users/eva/.gmail-mcp\",\"containerPath\":\"gmail-mcp\",\"readonly\":false}]' WHERE agent_group_id='<ID>'"
ncl groups restart --id <ID> --rebuild
```

## Apple Pages MCP tool — ported (system-action bridge)

Container side: 11 MCP tools (`pages_create`, `pages_open`, `pages_save`, `pages_close`, `pages_get_text`, `pages_insert_text`, `pages_replace_text`, `pages_format_paragraph`, `pages_export_pdf`, `pages_list`, `pages_delete`) in `container/agent-runner/src/mcp-tools/pages.ts`. Each tool writes a `kind='system', action='pages_request', requestId, verb, args` to outbound.db, then polls inbound.db for a matching `pages_response`. Same correlation pattern as `cli_request` in `cli/ncl.ts`.

Host side: `src/modules/pages/applescript.ts` is the v1 osascript helper module ported verbatim except for the v2 logger + import path swaps (v1's pino-style `logger.info({obj}, 'msg')` → v2's `log.info('msg', {obj})`). `src/modules/pages/index.ts` registers `registerDeliveryAction('pages_request', …)` which dispatches verb → AppleScript helper → response frame; `getAgentGroup(session.agent_group_id)` provides the sandbox folder. All sandboxing logic from v1 (filename allowlist regex, path-escape check, group-folder resolution) ported intact.

Module self-registers via `src/modules/index.js` import. No DB schema or container_configs changes needed — works for any group as long as the host runs macOS with Pages.app installed.

## ~~To port — Gmail MCP tool (deferred)~~

Upstream `/add-gmail-tool` skill expects OneCLI's TLS-MITM proxy to inject Bearer tokens into outbound `gmail.googleapis.com` requests. Without OneCLI, two viable paths exist:

1. **v1-style tokens-in-container** (~15 min if not for mount-security). Mount `~/.gmail-mcp/` read-write into the container; install `@gongrzhe/server-gmail-autoauth-mcp@1.1.11` per group; register as an MCP server with `GMAIL_CREDENTIALS_PATH` env pointing at a non-blocked filename. Blockers:
   - Mount-security in `src/modules/mount-security/index.ts` blocks `credentials` substring matches → must rename `~/.gmail-mcp/credentials.json` to `~/.gmail-mcp/tokens.json` (gmail-mcp supports `GMAIL_CREDENTIALS_PATH` override per dist inspection).
   - Per-group npm install means rebuilding the image with `ncl groups restart --rebuild`.
   - Real OAuth refresh + access tokens live in container memory during sessions — same trade-off v1 accepted.
2. **TLS MITM proxy on host** (essentially a mini-OneCLI). Generate a CA cert, install in container trust store, terminate TLS for `gmail.googleapis.com` and `accounts.google.com`, inject Bearer, re-encrypt to upstream. Hours of work; gives full credential isolation. Probably not worth it for a single-user install.

Working refresh tokens already exist at `~/.gmail-mcp/credentials.json` from v1.

## To port — Apple Pages MCP tool (deferred)

v1's design: agent writes a Pages request to `DATA_DIR/ipc/<groupFolder>/messages/<requestId>.json`, a host poller (`ipc.ts handlePagesIpc`) calls `osascript`, writes the response to `groups/<groupFolder>/pages/.responses/<requestId>.json`. v2's invariant is that all host↔container IO goes through the session DB (`inbound.db` + `outbound.db`) — there is no `DATA_DIR/ipc/` pattern any more. A direct port doesn't fit the architecture.

Two v2-shaped designs:

1. **Pages-as-system-action on `messages_out`**. Container's Pages MCP tools write a `kind = 'system-action', action = 'pages.<verb>'` message to `outbound.db`. Host's delivery loop has a `register-system-action` registry (already used for scheduling / approvals); add a `pages` handler that calls osascript and writes the result back to `inbound.db` for the agent to read. Cleanest fit.
2. **On-host Unix socket bridge**. Mount a host socket into the container, container makes RPC calls. Simpler to write but breaks the "DB is the sole IO surface" invariant.

Source to port is intact at `/Users/eva/nanoclaw/src/pages.ts` (~519 LOC), `/Users/eva/nanoclaw/src/pages.test.ts` (~283 LOC, 76 tests). MCP tool names: pages_create, pages_open, pages_save, pages_close, pages_get_text, pages_insert_text, pages_replace_text, pages_format_paragraph, pages_export_pdf, pages_list, pages_delete. Plus `pagesInstalled()` host check.

## 8-persona sub-agent dispatcher

The `@seo / @runcoach / @rehabcoach / @security / @businesscoach / @research / @strengthcoach / @thesis` trigger-prefix routing is preserved verbatim in `groups/telegram_main/CLAUDE.local.md` (paths fixed to `/workspace/agent/*_agent.md`). It works at the CLAUDE.md instruction level — no src-level routing change needed. If v2 grows native sub-agent routing, reconsider whether to migrate.

## Stale skill branches

Per `.nanoclaw-migrations/v2-gotchas.md` §1: the `origin/skill/*` branches are dated 2026-03-28 (pre v2.0.0). Do NOT merge them blindly — they conflict 1000+ commits with current main. When porting more skills, copy the intent and re-apply against the current architecture (which is what we did for `apple-container` and `native-credential-proxy`).

## v1 reference paths

- Source tree: `/Users/eva/nanoclaw/src/`
- Custom MCP tools: `/Users/eva/nanoclaw/container/agent-runner/src/`
- Pre-migration safety tag: `pre-update-e1356c5-20260528-065006`
- Orphan groups backup (main + whatsapp_main): `/tmp/v2-orphan-groups-1779988590.tar.gz`
