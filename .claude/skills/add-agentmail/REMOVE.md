# Remove AgentMail Email Channel

Every step is idempotent — safe to re-run.

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if
already gone):

```typescript
import './agentmail.js';
```

Then delete the copied adapter and its registration test:

```bash
rm -f src/channels/agentmail.ts src/channels/agentmail-registration.test.ts
```

## 2. Remove credentials

Remove `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID`, `AGENTMAIL_MODE`,
`AGENTMAIL_POLL_SCHEDULE`, and `AGENTMAIL_WEBHOOK_SECRET` (whichever are set —
only one mode's variables will be) from `.env`.

## 3. Remove the packages

```bash
pnpm uninstall agentmail svix
```

## 4. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
