# Remove iMessage

Reverses whatever `/add-imessage` installed — either backend. Detect which one
is present and reverse it. Every step is idempotent — safe to re-run. (The
provisioning wizard `scripts/photon-setup.ts` ships in trunk and is left in
place.)

## 1. Remove the self-registration import

Delete the `import './imessage.js';` line from `src/channels/index.ts` (delete
the line, don't comment it out).

## 2. Delete the adapter + its tests

```bash
rm -f src/channels/imessage.ts src/channels/imessage.test.ts src/channels/imessage-registration.test.ts
```

## 3. Uninstall the backend package(s)

Uninstall whichever is present. For the local backend, delete its
`better-sqlite3` override first, so the uninstall also drops it from the
lockfile (an empty `"pnpm": { "overrides": {} }` left in `package.json` is
harmless):

```bash
pnpm pkg delete 'pnpm.overrides[@photon-ai/imessage-kit>better-sqlite3]'   # local backend
pnpm uninstall chat-adapter-imessage   # local backend
pnpm uninstall spectrum-ts             # hosted backend
```

## 4. Remove credentials

Strip these from `.env` (skip any not present):

```bash
# selector + local backend
IMESSAGE_BACKEND
IMESSAGE_ENABLED
# legacy Chat-SDK remote mode (removed) — clean up stragglers
IMESSAGE_LOCAL
IMESSAGE_SERVER_URL
IMESSAGE_API_KEY
# hosted backend
PHOTON_PROJECT_ID
PHOTON_PROJECT_SECRET
PHOTON_MARKDOWN
PHOTON_TELEMETRY
PHOTON_MAX_INLINE_ATTACHMENT_BYTES
PHOTON_DASHBOARD_HOST
PHOTON_SPECTRUM_HOST
```

## 5. Remove the cached device token (optional, hosted)

```bash
rm -f data/photon-auth.json
```

## 6. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# systemctl --user restart $(systemd_unit)            # Linux
```

## 7. Unwire and delete the messaging group (optional)

Other tables point at `messaging_groups`, so clear them first, in one
transaction. This also deletes the iMessage sessions, the same way
`ncl groups delete` does. An `agent-shared` session that started on iMessage
goes too, so the agent's other channels start a fresh session on their next
message. Session folders under `data/v2-sessions/` stay on disk.

```bash
pnpm exec tsx scripts/q.ts data/v2.db "
BEGIN;
DELETE FROM pending_questions WHERE session_id IN (SELECT id FROM sessions
  WHERE messaging_group_id IN (SELECT id FROM messaging_groups WHERE channel_type='imessage'));
DELETE FROM pending_approvals WHERE session_id IN (SELECT id FROM sessions
  WHERE messaging_group_id IN (SELECT id FROM messaging_groups WHERE channel_type='imessage'));
DELETE FROM session_claims WHERE session_id IN (SELECT id FROM sessions
  WHERE messaging_group_id IN (SELECT id FROM messaging_groups WHERE channel_type='imessage'));
DELETE FROM delivery_attempts WHERE session_id IN (SELECT id FROM sessions
  WHERE messaging_group_id IN (SELECT id FROM messaging_groups WHERE channel_type='imessage'));
DELETE FROM wake_signals WHERE session_id IN (SELECT id FROM sessions
  WHERE messaging_group_id IN (SELECT id FROM messaging_groups WHERE channel_type='imessage'));
DELETE FROM sessions WHERE messaging_group_id IN
  (SELECT id FROM messaging_groups WHERE channel_type='imessage');
DELETE FROM agent_destinations WHERE target_type='channel' AND target_id IN
  (SELECT id FROM messaging_groups WHERE channel_type='imessage');
DELETE FROM user_dms WHERE messaging_group_id IN
  (SELECT id FROM messaging_groups WHERE channel_type='imessage');
DELETE FROM pending_sender_approvals WHERE messaging_group_id IN
  (SELECT id FROM messaging_groups WHERE channel_type='imessage');
DELETE FROM pending_channel_approvals WHERE messaging_group_id IN
  (SELECT id FROM messaging_groups WHERE channel_type='imessage');
DELETE FROM messaging_group_agents WHERE messaging_group_id IN
  (SELECT id FROM messaging_groups WHERE channel_type='imessage');
DELETE FROM messaging_groups WHERE channel_type='imessage';
COMMIT;
"
```

Then restart the service again. The running host still holds state for the
deleted sessions in memory, such as pending approval requests, and on startup
it stops their containers.

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# systemctl --user restart $(systemd_unit)            # Linux
```

## 8. Delete the Photon project (optional, hosted)

To fully deprovision, delete the `NanoClaw` project from the
[Photon dashboard](https://app.photon.codes). This releases the iMessage line.
