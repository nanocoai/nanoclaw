# Remove add-error-reports

1. Delete the barrel line (delete, don't comment out) from `src/modules/index.ts`:

   ```
   import './error-reports/index.js';
   ```

2. Delete the copied module and its test:

   ```bash
   rm -rf src/modules/error-reports
   ```

3. Remove `ERROR_REPORTS_MESSAGING_GROUP`, `ERROR_REPORTS_THREAD_ID`, and
   `ERROR_REPORTS_QUIET_MINUTES` from `.env`.

4. Rebuild and restart:

   ```bash
   pnpm run build
   bash setup/lib/restart.sh
   ```
