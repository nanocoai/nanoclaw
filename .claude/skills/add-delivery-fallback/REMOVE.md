# Remove delivery fallback

Safe to re-run when some steps were never applied.

1. Delete the barrel line from `src/modules/index.ts`:

   ```typescript
   import './delivery-fallback/index.js';
   ```

2. Delete the copied files:

   ```bash
   trash src/modules/delivery-fallback
   ```

3. Remove `DELIVERY_FALLBACK_FROM`, `DELIVERY_FALLBACK_TO` and `DELIVERY_FALLBACK_COOLDOWN_MS` from `.env`.

4. Rebuild and restart:

   ```bash
   pnpm run build
   ```
