# Remove Slack

Every step is idempotent — safe to re-run.

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './slack.js';
```

Then delete the copied adapter, its registration test, and the `slack-formatting`
container skill (part of the channel payload — trunk doesn't ship it):

```bash
rm -f src/channels/slack.ts src/channels/slack-registration.test.ts container/skills/slack-formatting/SKILL.md
```

## 2. Remove credentials

Remove `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_SIGNING_SECRET` from
`.env` (each is present only if its delivery mode was configured).

## 3. Remove the package

```bash
pnpm uninstall @chat-adapter/slack
```

## 4. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
