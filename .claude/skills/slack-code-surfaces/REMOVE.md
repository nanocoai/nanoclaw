# Remove Slack coding-session surfaces

Every step is idempotent — safe to re-run.

## 1. Remove the registrations

Delete the appended lines from `src/channels/index.ts` (skip any already gone):

- `import './slack-code-surfaces.js';`
- `import './slack-code-surfaces-policy.js';`

## 2. Remove the payload files

```bash
rm -f src/channels/slack-bot-identity.ts src/channels/slack-code-surfaces.ts \
  src/channels/slack-code-surfaces-policy.ts src/channels/slack-code-surfaces.test.ts
```

## 3. Remove the cached identity (optional)

```bash
rm -f data/slack-bot-identity.json
```

`SLACK_A2A_MAX_HOPS` in `.env` is shared with `/slack-a2a-rooms`; leave it if
that skill stays.

## 4. Rebuild and restart

```bash
pnpm run build
bash setup/lib/restart.sh
```

New sandboxes get no Slack channel afterwards; bindings that exist are
mirrored through the no-op provider until archived (`ncl sandboxes surface
archive <name>` still works from the surface module). The guard's default
applies again in surface channels: bot-authored inbound is dropped there.
