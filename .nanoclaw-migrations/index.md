# NanoClaw v1 → v2 Migration Guide (intent-based)

Generated: 2026-05-27
Source branch: `nixos-deploy` @ `7cc6d27` (v1.2.46)
Target: `origin/main` @ `2492259` (v2.0.70)
Backup tag: `archive/v1-pre-v2-migration`
Server snapshot: `/tmp/nanoclaw-state/` (see `INVENTORY.md` there)

## Approach

**Intent-based, not merge-based.** We do NOT run `migrate-v2.sh`. For each v1 customization we ask:

1. Is the problem still relevant in v2?
2. Does v2 solve it idiomatically (skill / built-in)?
3. If yes — use that. If no — implement minimally and idiomatically in v2 layout.

User explicit decisions (Telegram conversation, 2026-05-27):
- **Telegram**: use upstream `/add-telegram` skill (Chat SDK bridge). No more local fork of `qwibitai/nanoclaw-telegram`.
- **Credentials**: v2 default = OneCLI Agent Vault. Apply `/init-onecli`, which migrates the OAuth token from `.env` into the vault. The NixOS module continues to drop the sops-managed token into `.env` for first-run ingest.
- **Voice transcription**: keep Groq Whisper (fast, light). Per-group bash script in `groups/<folder>/scripts/` — v2 has no transcription skill to reuse. See [04-voice.md](04-voice.md).
- **Formatting**: HTML via a new skill **`/use-telegram-html`** — written to upstream-PR quality from day one (full SKILL.md + REMOVE.md + VERIFY.md, idempotent, sentinel-marked for re-apply detection). Layers on `/add-telegram`, bypasses the Chat SDK's hardcoded Markdown via direct `fetch` with `parse_mode=HTML`. After local verification, submit as upstream PR. See [03-formatting.md](03-formatting.md).
- **Bybit / Valtrex**: scripts copy 1:1 into `groups/<folder>/scripts/`. NPM deps via `ncl groups config add-package --npm` (baked into image, requires `--rebuild`).
- **Tailscale**: Path A — host-side `tailscaled` + `/var/run/tailscale/tailscaled.sock` mounted into container via `additional_mounts`. Host identity shared with agent. No separate per-container Tailscale state.
- **NixOS networking patch**: keep, but should upstream as PR. See [06-nixos-network.md](06-nixos-network.md).

## Migration Plan (Tier 3)

### Stage 1 — Infra & build
1. Apply NixOS networking patch + open PR — [06-nixos-network.md](06-nixos-network.md)
2. Apply `/init-onecli` skill — [02-credentials.md](02-credentials.md)
3. Build container image
4. Validate that v2 stub runs (no chat yet)

### Stage 2 — Channel
5. Apply `/add-telegram` skill — [01-channels.md](01-channels.md)
6. Pair the bot (`telegram_main`, JID `tg:42582289`)
7. Create + apply `/use-telegram-html` skill — [03-formatting.md](03-formatting.md). Patches the installed adapter, sets HTML formatting block in `CLAUDE.local.md`.

### Stage 3 — Group state
9. Restore data into v2 group folder — [07-data-restore.md](07-data-restore.md)
10. Re-create the agent group via `ncl groups create`
11. Wire `messaging_groups` → `agent_groups` via `ncl wirings create`

### Stage 4 — Capabilities
12. Voice transcription via Groq — [04-voice.md](04-voice.md)
13. Business logic (Bybit, Valtrex) — [05-business-logic.md](05-business-logic.md)
14. Re-create scheduled tasks via agent (`schedule_task` MCP tool) or `ncl`

### Stage 5 — Deploy
15. Update NixOS module in `~/Documents/GitHub/nixserver/` for v2 paths (`data/v2.db`, two-DB session split)
16. Live test from the worktree before swap
17. Switch live service

## Risk Areas

- **Container image rebuild**: v2 bakes npm packages into the image — `ncl groups config add-package --npm <pkg>` for `puppeteer-extra`, `ssh2`, `tweetnacl`; then `ncl groups restart --rebuild`. Not runtime install.
- **DB break**: v1's `store/messages.db` is incompatible with v2's `data/v2.db` + per-session split. We deliberately drop chat history (234 messages, recoverable from Telegram if needed) and reseed registered group + scheduled tasks.
- **HTML formatting in v2**: Chat SDK adapter hardcodes Markdown. Our `/use-telegram-html` skill is the delta on this fork. ~30 lines of code we own — minimal, idempotent, removable. Watch upstream for `vercel/chat PR #367`; when it lands we can collapse to a config knob.
- **NixOS module rewrite**: deploy infra in `nixserver` repo still references v1 paths/units. Out of scope for this repo but blocks the production cutover.

## Skill Interactions

- `/init-onecli`, `/add-telegram`, `/use-telegram-html`: apply in that order. `/use-telegram-html` requires `/add-telegram`; both are independent of `/init-onecli`.
- `/init-onecli` and `/add-telegram` are clean upstream skills. `/use-telegram-html` is our new skill, written to upstream-PR quality — same conventions, same Phase structure, same file set.

## Status

- [x] Plan drafted
- [ ] Stage 1 — Infra & build
- [ ] Stage 2 — Channel
- [ ] Stage 3 — Group state
- [ ] Stage 4 — Capabilities
- [ ] Stage 5 — Deploy
