# Remove Mattermost

Every step is idempotent and safe to re-run.

## 1. Remove the registration

Delete `import './mattermost.js';` from `src/channels/index.ts`, skipping it if
it is already absent.

## 2. Remove the channel files

```bash
rm -f src/channels/mattermost.ts src/channels/mattermost-registration.test.ts
rm -rf src/channels/mattermost-adapter
```

## 3. Remove credentials

Remove `MATTERMOST_BASE_URL`, `MATTERMOST_BOT_TOKEN`,
`MATTERMOST_CALLBACK_URL`, and `MATTERMOST_CALLBACK_SECRET` from `.env`.

## 4. Remove direct dependencies

Check whether any remaining channel still imports `ws`:

```bash
grep -rl "require('ws')\|from 'ws'" src/channels
```

The adapter removed in step 2 was the only trunk consumer, so if the grep
matches nothing, remove the dependencies:

```bash
pnpm uninstall ws @types/ws
```

## 5. Optional local server

The evaluation server is deliberately not removed automatically because its
volumes contain Mattermost data. Stopping it keeps that data:

```bash
docker compose -f .nanoclaw/mattermost/compose.yml down
```

Only when the operator explicitly confirms the Mattermost database and uploads
should be erased, add `-v` to that command to delete the volumes as well. Also
delete `.nanoclaw/mattermost/` afterwards if the stack is gone for good.

## 6. Rebuild and restart

```bash
pnpm run build
bash setup/lib/restart.sh
```
