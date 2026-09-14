# Remove local web chat

Remove the adapter and its tests:

```bash
rm -f \
  scripts/local-web-preview.ts \
  scripts/local-web-url.ts \
  src/channels/local-web.ts \
  src/channels/local-web-conversations.ts \
  src/channels/local-web-page.html \
  src/channels/local-web-page.css \
  src/channels/local-web-chat.css \
  src/channels/local-web-conversations.css \
  src/channels/local-web-page.js \
  src/channels/local-web-conversation-ui.js \
  src/channels/local-web-conversation-ui.test.ts \
  src/channels/local-web-registration.test.ts \
  src/channels/local-web.test.ts \
  src/channels/local-web-conversations.test.ts \
  src/channels/local-web-default-provider.test.ts \
  src/channels/local-web-isolation.test.ts \
  src/channels/local-web-page.test.ts \
  src/channels/local-web-provider-inheritance.test.ts
```

Delete the browser's access token at `data/local-web/token` if the channel is
not being reinstalled.

Delete `import './local-web.js';` from `src/channels/index.ts`. If set, remove
`NANOCLAW_LOCAL_WEB_PORT` from `.env`, then remove the adapter dependency:

```bash
pnpm pkg delete scripts.local-web
pnpm remove markdown-it
```

Delete every `local-web` wiring and messaging group with `ncl wirings delete`
and `ncl messaging-groups delete`. If this skill registered `local-web:local`,
also remove its memberships and revoke the role selected during wiring with
`ncl members remove` and `ncl roles revoke`. Then rebuild and restart NanoClaw:

```bash
pnpm exec tsx setup/index.ts --step service
```
