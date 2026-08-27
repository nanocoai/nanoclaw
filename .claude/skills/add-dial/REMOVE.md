# Remove Dial

1. Remove `import './dial.js';` from `src/channels/index.ts`
2. Delete `src/channels/dial.ts` and `src/channels/dial-registration.test.ts`
3. Unregister the inbound command target (optional): `dial local-target remove "$PWD/data/dial/handle-dial-event.sh"`
4. Remove the spool/handler artifacts (optional): `rm -rf data/dial`
5. Remove any `DIAL_*` overrides from `.env`
6. Rebuild and restart

The Dial account itself, its number, and the `dial listen` daemon are managed by the `dial` CLI, not NanoClaw — remove them separately with `dial listen uninstall` etc. if you no longer want them.
