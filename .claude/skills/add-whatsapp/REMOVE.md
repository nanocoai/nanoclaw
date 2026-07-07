# Remove WhatsApp

Every step is idempotent — safe to re-run.

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './whatsapp.js';
```

Then delete the copied adapter, its registration test, and its unit test:

```bash
rm -f src/channels/whatsapp.ts src/channels/whatsapp-registration.test.ts src/channels/whatsapp.test.ts
```

## 2. Remove the setup steps

Delete these entries from the `STEPS` map in `setup/index.ts` (skip lines already gone):

```typescript
groups: () => import('./groups.js'),
'whatsapp-auth': () => import('./whatsapp-auth.js'),
```

> Keep `groups: ...` if another installed channel relies on the `groups` setup step. Only the `'whatsapp-auth':` entry is WhatsApp-specific.

Then delete the copied setup step files:

```bash
rm -f setup/whatsapp-auth.ts
```

> Keep `setup/groups.ts` if another installed channel relies on it.

## 3. Remove credentials

Remove `ASSISTANT_HAS_OWN_NUMBER` from `.env` (only present if a dedicated number was configured), then re-sync to the container:

```bash
mkdir -p data/env && cp .env data/env/env
```

## 4. Remove the packages

```bash
pnpm uninstall @whiskeysockets/baileys qrcode @types/qrcode pino
```

## 5. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```

## 6. Remove auth state (optional)

To fully remove the linked-device authentication and session state:

```bash
rm -rf store/auth/
```

> **Warning:** This unlinks the device. Re-installing WhatsApp requires re-pairing from your phone via QR or pairing code (see SKILL.md Credentials).

To keep the linked device for a later reinstall, leave `store/auth/` intact.
