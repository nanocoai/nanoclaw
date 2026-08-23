# Remove Slack

Every step is idempotent — safe to re-run.

## 1. Remove the registrations

Delete the appended lines (skip any already gone):

- `src/channels/index.ts`: `import './slack.js';` and `import './slack-a2a-guard.js';`

## 2. Remove the payload files

```bash
rm -f src/channels/slack.ts src/channels/slack-lib.ts src/channels/slack-lib.test.ts \
  src/channels/slack-a2a-guard.ts src/channels/slack-a2a-guard.test.ts \
  src/channels/slack-registration.test.ts \
  src/channels/slack-instances-registration.test.ts \
  src/provisioning/slack-app.ts src/provisioning/slack-app.test.ts \
  container/skills/slack-formatting/SKILL.md
```

## 3. Remove credentials

Remove `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_SIGNING_SECRET` from
`.env` (each is present only if its delivery mode was configured). If named
instances were configured, also remove `SLACK_INSTANCES` and every suffixed
`SLACK_BOT_TOKEN_<NAME>` / `SLACK_APP_TOKEN_<NAME>` /
`SLACK_SIGNING_SECRET_<NAME>` line.

## 4. Remove the package

```bash
pnpm uninstall @chat-adapter/slack
```

## 5. Feature skills

If the agents feature was applied on top, remove those skills first:
`slack-agent-flow` (its REMOVE.md), then `slack-a2a-rooms` (removal steps in
its SKILL.md).

## 6. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
