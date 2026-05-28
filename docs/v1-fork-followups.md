# v1 → v2 fork follow-ups

Done during the 2026-05-28 migration; this file lists v1 fork customizations still to port. The v1 install lives at `/Users/eva/nanoclaw` (read-only reference). Pre-migration backup: tag `pre-update-e1356c5-20260528-065006` in that repo.

## Already ported

- **Runtime → Apple Container** (commit `179edc7`). Replaces Docker because the host runs Apple Container at `/opt/homebrew/bin/container`.
- **Credentials → native proxy** (commit `b833f80`). Drops the OneCLI/docker-compose dependency. Reads `CLAUDE_CODE_OAUTH_TOKEN` from `.env` and forwards to `api.anthropic.com` with the token injected as `Authorization: Bearer`. Container env uses `ANTHROPIC_AUTH_TOKEN=placeholder` (not `CLAUDE_CODE_OAUTH_TOKEN`) so the CLI uses Bearer directly and skips the `create_api_key` exchange that fails on Pro-tier tokens.

## To port — Telegram channel customizations

Stock `/add-telegram` is wired and answering live. The fork's Telegram extensions still need porting on top of `src/channels/telegram.ts`:

- **Image vision / photo handling** — v1 downloads photos and constructs multimodal content blocks so the agent can see them. Without this, photo messages are silently dropped or sent as text-only.
- **4-bot swarm multiplexing** — v1 uses `TELEGRAM_BOT_POOL` (4 tokens) and round-robins outbound messages to dodge per-bot rate limits. The pool variable still lives in `.env`. Stock v2 only reads `TELEGRAM_BOT_TOKEN` (single bot). Reference: how the v1 outbound code picks a bot per message.
- **Reply / quoted-message context capture** — v1 includes the quoted message in the agent's prompt when the user replies to a previous bot message. v2 currently ignores the reply chain.
- **File-too-big graceful handling** — v1 sends a clear "file too big" message instead of crashing the adapter when a large attachment arrives.

## To port — Apple Pages MCP tools

Custom local-only skill (`/add-pages`) — not in upstream, lives only on `skill/add-pages` in the v1 repo. Approximate scope: ~470 LOC `src/pages.ts` + 19 unit tests + 11 MCP tool registrations. In v2 these belong under `container/agent-runner/src/mcp-tools/pages.ts` following the split-file pattern of `core.ts`, `interactive.ts`, etc.

## To port — Gmail tool

`/add-gmail-tool` upstream skill exists; v1 wired it locally with the OneCLI OAuth flow. Re-evaluate whether it still works with the native credential proxy or needs a parallel path.

## To port — Container memory tuning

v1 set Docker container memory to ≥2 GB so Chromium (used by `agent-browser`) wouldn't OOM. v2's `container_configs` table (`pnpm exec tsx scripts/q.ts data/v2.db "PRAGMA table_info(container_configs)"`) has no `memory` column today; `src/container-runner.ts` never passes `--memory` to the runtime. If agent-browser OOMs, expose a column and wire `--memory <size>` into `buildContainerArgs`.

## 8-persona sub-agent dispatcher

The `@seo / @runcoach / @rehabcoach / @security / @businesscoach / @research / @strengthcoach / @thesis` trigger-prefix routing is preserved verbatim in `groups/telegram_main/CLAUDE.local.md` (paths fixed to `/workspace/agent/*_agent.md`). It works at the CLAUDE.md instruction level — no src-level routing change needed. If v2 grows native sub-agent routing, reconsider whether to migrate.

## Stale skill branches

Per `.nanoclaw-migrations/v2-gotchas.md` §1: the `origin/skill/*` branches are dated 2026-03-28 (pre v2.0.0). Do NOT merge them blindly — they conflict 1000+ commits with current main. When porting more skills, copy the intent and re-apply against the current architecture (which is what we did for `apple-container` and `native-credential-proxy`).

## v1 reference paths

- Source tree: `/Users/eva/nanoclaw/src/`
- Custom MCP tools: `/Users/eva/nanoclaw/container/agent-runner/src/`
- Pre-migration safety tag: `pre-update-e1356c5-20260528-065006`
- Orphan groups backup (main + whatsapp_main): `/tmp/v2-orphan-groups-1779988590.tar.gz`
