# Remove DeltaChat

## 1. Disable the adapter

Comment out the import in `src/channels/index.ts`:

```typescript
// import './deltachat.js';
```

## 2. Remove credentials

Remove the `DC_*` lines from `.env`:

```bash
DC_EMAIL
DC_PASSWORD
DC_IMAP_HOST
DC_IMAP_PORT
DC_SMTP_HOST
DC_SMTP_PORT
```

## 3. Rebuild and restart

Run from your NanoClaw project root:

```bash
pnpm run build
source setup/lib/install-slug.sh

# Linux
systemctl --user restart $(systemd_unit)

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
```

## 4. Remove account data (optional)

To fully remove all account data including DeltaChat encryption keys:

```bash
rm -rf dc-account/
```

> **Warning:** This deletes the Autocrypt keys. Contacts who have verified your bot's key will need to re-verify if the same email address is re-used with a new account.

To keep the account for later reinstall, leave `dc-account/` intact.

## 5. Remove the package (optional)

```bash
pnpm remove @deltachat/stdio-rpc-server
```

## Verification

After removal, confirm the adapter is no longer starting:

```bash
grep "deltachat" logs/nanoclaw.log | tail -5
```

Expected: no `Channel adapter started` entry after the last restart.
