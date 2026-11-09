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
bash setup/lib/restart.sh
```

## 7. Unwire and delete the messaging group (optional)

With the service running, delete each iMessage messaging group from the
project root. `ncl messaging-groups delete` removes the group and every row
that points at it in one transaction; `bin/ncl messaging-groups help delete`
lists what it clears. `bin/ncl` (not a global `ncl`) keeps the delete on this
install.

```bash
(
  ids=$(pnpm exec tsx scripts/q.ts data/v2.db "SELECT id FROM messaging_groups WHERE channel_type='imessage'") || exit 1
  for id in $(printf '%s\n' "$ids"); do
    bin/ncl messaging-groups delete --id "$id" || exit 1
  done
)
```

## 8. Delete the Photon project (optional, hosted)

To fully deprovision, delete the `NanoClaw` project from the
[Photon dashboard](https://app.photon.codes). This releases the iMessage line.
