# Remove env passthrough

Idempotent — safe to run even if some steps were never applied.

1. Delete the barrel line (delete, don't comment out) from `src/modules/index.ts`:

   ```ts
   import './env-passthrough/index.js';
   ```

2. Delete the copied payload, including its tests:

   ```bash
   trash src/modules/env-passthrough
   ```

3. Delete the `CONTAINER_ENV_PASSTHROUGH` line from `.env`. The variables it named are the operator's own settings; leave them if something else reads them.

4. Rebuild and restart, then recreate running containers so they drop the forwarded env:

   ```bash
   pnpm run build
   bash setup/lib/restart.sh
   ```
