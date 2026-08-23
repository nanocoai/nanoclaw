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

Uninstall whichever is present:

```bash
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

```bash
pnpm exec tsx scripts/q.ts data/v2.db "
DELETE FROM messaging_group_agents WHERE messaging_group_id IN
  (SELECT id FROM messaging_groups WHERE channel_type='imessage');
DELETE FROM messaging_groups WHERE channel_type='imessage';
"
```

## 8. Delete the Photon project (optional, hosted)

To fully deprovision, delete the `NanoClaw` project from the
[Photon dashboard](https://app.photon.codes). This releases the iMessage line.
