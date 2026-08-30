# Remove local web chat

Remove the adapter and its tests:

```bash
rm -f \
  src/channels/local-web.ts \
  src/channels/local-web-page.html \
  src/channels/local-web-page.css \
  src/channels/local-web-page.js \
  src/channels/local-web-registration.test.ts \
  src/channels/local-web.test.ts
```

Delete the browser's access token at `data/local-web/token` if the channel is
not being reinstalled.

Delete `import './local-web.js';` from `src/channels/index.ts`. If set, remove
`NANOCLAW_LOCAL_WEB_PORT` from `.env`, then remove the adapter dependency:

```bash
pnpm remove markdown-it
```

Delete the `local-web` wiring and messaging group with `ncl wirings delete` and
`ncl messaging-groups delete`. If this skill registered `local-web:local`, also
remove its membership and revoke the role selected during wiring with
`ncl members remove` and `ncl roles revoke`. Then rebuild and restart NanoClaw:

```bash
pnpm exec tsx setup/index.ts --step service
```
