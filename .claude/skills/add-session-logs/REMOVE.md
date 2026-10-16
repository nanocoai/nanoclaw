# Remove per-session container logs

Delete `import './session-file-log.js';` from `src/drivers/installed.ts`, leaving
other imports.

Delete the files this skill copied:

- `src/drivers/session-file-log.ts`
- `src/drivers/session-file-log.test.ts`

Rebuild and restart the service. Existing `logs/sessions/*.log` files are left
in place; delete them if you no longer want them. If you set
`NANOCLAW_SESSION_LOG_DIR` or `NANOCLAW_SESSION_LOG_MAX_BYTES` in `.env`, remove
those lines.
