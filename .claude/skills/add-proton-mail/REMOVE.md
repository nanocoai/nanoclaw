# Remove Proton Mail

Every step is idempotent — safe to re-run.

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './proton-mail.js';
```

Then delete the copied adapter and its tests:

```bash
rm -f src/channels/proton-mail.ts src/channels/proton-mail-registration.test.ts src/channels/proton-mail.test.ts src/channels/proton-mail-adapter.test.ts
```

## 2. Remove the dependencies

```bash
pnpm remove imapflow mailparser nodemailer @types/mailparser @types/nodemailer
```

## 3. Remove credentials and state

Remove the `PROTON_MAIL_*` lines from `.env`:

```bash
PROTON_MAIL_ADDRESS
PROTON_MAIL_BRIDGE_PASSWORD
PROTON_MAIL_FROM_NAME
PROTON_MAIL_IMAP_HOST
PROTON_MAIL_IMAP_PORT
PROTON_MAIL_SMTP_HOST
PROTON_MAIL_SMTP_PORT
PROTON_MAIL_TLS_CA_FILE
PROTON_MAIL_TLS_REJECT_UNAUTHORIZED
PROTON_MAIL_MAILBOX
PROTON_MAIL_POLL_SECONDS
PROTON_MAIL_MARK_SEEN
PROTON_MAIL_PROCESS_BACKLOG
PROTON_MAIL_DEFAULT_SUBJECT
```

Delete the adapter's state (mailbox cursor, threads, pending cards) and the
pinned Bridge certificate:

```bash
rm -rf store/proton-mail
```

Versions of this skill before the bridge password was written by
`store-secrets.sh` printed it into the setup step log. Delete any such log:

```bash
rm -f logs/setup-steps/*-skill-add-proton-mail.log
```

## 4. Stop and remove Proton Mail Bridge

Stop the Bridge container and delete its image and network. The named volume
holds the Proton login — removing it deletes this device's login (Proton also
lists it under Settings → Security → Sessions, where it can be revoked):

```bash
docker rm -f nanoclaw-proton-bridge 2>/dev/null || true
docker rmi nanoclaw-proton-bridge:latest 2>/dev/null || true
docker network rm nanoclaw-mail 2>/dev/null || true
docker volume rm nanoclaw-proton-bridge 2>/dev/null || true
```

## 5. Rebuild and restart

Run from your NanoClaw project root:

```bash
pnpm run build
source setup/lib/install-slug.sh

# Linux
systemctl --user restart $(systemd_unit)

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
```

Messaging groups, users and wirings for `proton-mail` are runtime data and are
left in the central DB; delete them with `ncl` if you want them gone.
