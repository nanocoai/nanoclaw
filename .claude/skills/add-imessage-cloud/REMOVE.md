# Remove imessage-cloud (native iMessage via Photon)

Reverses everything `/add-imessage-cloud` added: the fetched adapter, its barrel import, its test, the runtime SDK, and the credentials. Every step is idempotent — safe to re-run. (The provisioning wizard `scripts/photon-setup.ts` ships in trunk and is left in place.)

## 1. Remove the self-registration import

Delete the `import './imessage-cloud.js';` line from `src/channels/index.ts` (delete the line, don't comment it out).

## 2. Delete the fetched adapter + test

```bash
rm -f src/channels/imessage-cloud.ts src/channels/imessage-cloud-registration.test.ts
```

## 3. Uninstall the runtime SDK

```bash
pnpm uninstall spectrum-ts
```

## 4. Remove credentials

Delete the `PHOTON_*` lines from `.env` (skip any not present):

```bash
PHOTON_PROJECT_ID
PHOTON_PROJECT_SECRET
PHOTON_MARKDOWN
PHOTON_TELEMETRY
PHOTON_MAX_INLINE_ATTACHMENT_BYTES
PHOTON_DASHBOARD_HOST
PHOTON_SPECTRUM_HOST
```

If you sync `.env` to `data/env/env`, re-run that sync (or `cp .env data/env/env`).

## 5. Remove the cached device token (optional)

```bash
rm -f data/photon-auth.json
```

## 6. Rebuild and restart

Run from your NanoClaw project root:

```bash
pnpm run build
source setup/lib/install-slug.sh

# Linux
systemctl --user restart $(systemd_unit)

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
```

## 7. Unwire and delete the messaging group (optional)

If you wired an iMessage DM/group to an agent, remove the join row and the messaging group:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "
DELETE FROM messaging_group_agents WHERE messaging_group_id IN
  (SELECT id FROM messaging_groups WHERE channel_type='imessage-cloud');
DELETE FROM messaging_groups WHERE channel_type='imessage-cloud';
"
```

## 8. Delete the Photon project (optional)

To fully deprovision, delete the `NanoClaw` project from the [Photon dashboard](https://app.photon.codes). This releases the iMessage line.
