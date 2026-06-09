# v2 migration gotchas (discovered 2026-05-28)

Notes for `/migrate-from-v1` (or whoever continues this migration) on top of the original `guide.md`. The guide was written 2026-04-24 against v2.0.13. Current v2 HEAD is 2.0.70 — these gotchas reflect that delta.

## 1. Skill branches are stale

The guide tells you to merge `upstream/skill/*` branches to reapply skills. Don't do this blindly — those branches are dated 2026-03-28 (pre v2.0.0, which shipped 2026-04-22). They were not rebased onto the v2 architecture rewrite. Verified:

```
git merge --no-commit --no-ff origin/skill/native-credential-proxy
# CONFLICT in: setup/verify.ts, src/config.ts, src/container-runner.test.ts,
#              src/container-runner.ts, src/index.ts
```

The v2 SKILL.md files (e.g. `.claude/skills/use-native-credential-proxy/SKILL.md`) still instruct merging these branches. They are out of sync with reality.

**What to do instead:**
- For Apple Container: run `/convert-to-apple-container` skill manually inside v2 — but be ready to resolve conflicts. Or port the changes by intent (replace `docker` → `container`, mount syntax, etc.).
- For native credential proxy: same — port the changes manually since v2 main uses OneCLI as the default.
- For channel-formatting, compact: similarly stale; check if the feature is already in v2 main before reapplying.

## 2. Some skills the user had are missing as branches

The guide references these v1 skills; in v2 the SKILL.md exists but the corresponding `upstream/skill/*` branch does NOT:
- `add-image-vision`
- `add-pdf-reader`
- `add-telegram-swarm`
- `add-voice-transcription`
- `use-local-whisper`
- `add-gmail-tool`
- `add-karpathy-llm-wiki` (only `skill/wiki` exists)

These features need to be reimplemented manually following the v2 patterns. The guide's source snippets remain useful as porting references.

## 3. Channels in v2 install via copy, not merge

`/add-telegram` in v2 does NOT merge a branch. It copies files from `origin/channels` and runs an install script. `migrate-v2.sh` Phase 2 will offer channel selection and run the install scripts (or use `NANOCLAW_CHANNELS=telegram,gmail`).

After channels are installed by migrate-v2.sh, the user's customizations on top of the Telegram channel (from `guide.md`'s Customizations section) need to be applied manually:
- Image vision (custom photo download + multimodal block construction)
- Swarm / bot-pool multiplexing
- Reply / quoted-message context capture
- File-too-big graceful handling

## 4. Service-name slug change (v2.0.63 BREAKING)

launchd label and systemd unit are now per-install slugs. Source `setup/lib/install-slug.sh` to get the actual names for this install:

```bash
source setup/lib/install-slug.sh && launchd_label   # macOS
source setup/lib/install-slug.sh && systemd_unit    # Linux
```

The guide's rollback procedure still references `com.nanoclaw.plist` — replace with the slugged name before pasting commands.

## 5. CLAUDE.md is generated in v2

v2 composes `groups/<folder>/CLAUDE.md` at every container spawn from:
- `container/CLAUDE.md` (shared base, RO mount)
- Per-skill `instructions.md` fragments
- Per-MCP `instructions` from `container.json`
- `groups/<folder>/CLAUDE.local.md` (user-editable, auto-loaded)

`migrate-v2.sh` copies v1's `groups/<folder>/CLAUDE.md` → `CLAUDE.local.md` automatically. **Don't edit the generated `CLAUDE.md` — edit `CLAUDE.local.md`.**

## 6. Apple Container memory config

The guide's "container memory must be at least 2GB" customization — verify where this lives in v2. The v2 `convert-to-apple-container` SKILL.md doesn't mention memory tuning. May have moved to container-config DB (v2.0.48 introduced `container_configs` table) or to `container/build.sh`. Grep for `1024`, `2048`, or `memory` in container scripts to find it.

## 7. Backup tag

Pre-migration safety net created in v1 install (`/Users/eva/nanoclaw`):
- Branch: `backup/pre-update-e1356c5-20260528-065006`
- Tag: `pre-update-e1356c5-20260528-065006`

Rollback v1 install: `git reset --hard pre-update-e1356c5-20260528-065006`

## 8. Customizations the user explicitly does NOT want

From the guide:
- **No WhatsApp.** Do not install `add-whatsapp` even if it appears in the channel multiselect default.
- **No OneCLI.** Use native credential proxy. OneCLI step in migrate-v2.sh will fail and that's expected.
- **No Docker.** Apple Container only. Docker check in migrate-v2.sh will fail; that's expected.

## 9. Custom local-only skill: add-pages

Not in upstream. Lives only on local branch `skill/add-pages` in `/Users/eva/nanoclaw`. See guide section "Apple Pages integration (custom skill — no upstream branch)" for the full porting plan. Approximate scope: ~470 LOC `src/pages.ts` + 19 unit tests + 11 MCP tool registrations.

When porting to v2, register MCP tools in `container/agent-runner/src/mcp-tools/pages.ts` following the pattern of the existing split tool files (`core.ts`, `interactive.ts`, etc.).
