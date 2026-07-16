# NanoClaw Migration Guide — eliabc VM

Generated: 2026-07-16
Base (merge-base): e263352aed2a10c8ec5c207391e650de1fb7e9f4
HEAD at generation: 071d3e57 (feat/quota-fallback + snapshot commit)
Upstream: origin/main e926e30e (includes PR #3012 provider-agnostic memory; #3013 lives on origin/providers)

## Migration Plan (order matters)

1. **Skills first** (worktree on origin/main):
   - `/add-telegram` — base Telegram adapter (upstream restructured channels: per-instance webhook route registry)
   - `/add-whatsapp` — base WhatsApp adapter (take upstream HEAD of channels branch; local copy was older)
   - `/add-codex` — codex provider from origin/providers (now includes #3013 memory SessionStart hook)
   - Copy custom skills as-is: `person-dossier`, `voice-messages` (see 06)
2. **Validate build** after skills.
3. **Source customizations**:
   - 03-pilot-activation.md — pilot module; migration 016 → renumber to **020**
   - 04-channels.md — local deltas on telegram.ts (pilot interceptor, pairing codes), whatsapp voice-note block
   - 02-quota-fallback.md — the big one; poll-loop semantic reintegration; migration 017 → renumber to **021** (migration runner dedups by `name`, keep names `pilot-activations` / `fallback-provider` unchanged — live DB already recorded them)
   - 06-skills-and-misc.md — approvals preferred-channel, mount-security guard, misc
4. **Validate**: pnpm build + test, container typecheck, bun test.
5. Pilot provisioning: verify provision.ts persona lands in `instructions.prepend.md` via upstream `initGroupFilesystem({instructions})` (signature unchanged — confirmed).

## Risk areas
- `poll-loop.ts` — upstream "one-door delivery" rework; reapply via semantic insertion points in 02, not textual patch.
- Migration numbering vs live v2.db schema_version (names must stay stable).
- handoff.ts SQL assumes `messages_in.kind IN ('chat','chat-sdk')` — re-verify post-merge.
- Local reasoning-effort passthrough superseded by upstream native support — do not reapply (see 05).

## Applied Skills
- add-telegram (channels branch), add-whatsapp (channels branch), add-codex (providers branch)
- Custom (copy as-is): `.claude/skills/person-dossier/`, container skill `voice-messages` — paths in 06.

## Sections
- [02-quota-fallback.md](02-quota-fallback.md)
- [03-pilot-activation.md](03-pilot-activation.md)
- [04-channels.md](04-channels.md)
- [05-codex-provider.md](05-codex-provider.md)
- [06-skills-and-misc.md](06-skills-and-misc.md)

## Rollback
Backup branch/tag created pre-upgrade (see git tags `pre-migrate-*`); full tar+DB backups in /home/exedev/nanoclaw-v2-backups/ (20260716-152748).
