# Remove /add-dashboard

Reverses every change the install made: three copied files, one dependency, one
block in `src/index.ts`, two `.env` lines. Every step is idempotent — safe to
run even if some pieces are already gone.

## 1. Delete the copied files

```bash
rm -f src/dashboard-pusher.ts src/dashboard-pusher.test.ts src/dashboard-wiring.test.ts
```

## 2. Uninstall the dependency

```bash
pnpm remove @nanoco/nanoclaw-dashboard
```

## 3. Remove the block from `src/index.ts`

Open `src/index.ts` and delete the dashboard block from `main()` — the comment,
the dynamic import, and the call:

```typescript
  // Dashboard (optional; no-ops without DASHBOARD_SECRET)
  const { startDashboard } = await import('./dashboard-pusher.js');
  await startDashboard();
```

That is the only edit the install made to core. Teardown was registered from
inside `dashboard-pusher.ts` (deleted in step 1), so `shutdown()` has nothing
to revert.

## 4. Remove the environment variables

Delete both lines from `.env`:

```
DASHBOARD_SECRET=...
DASHBOARD_PORT=...
```

## 5. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)

# Linux
systemctl --user restart $(systemd_unit)
```

The build is the check: a forgotten step-3 block fails with
`TS2307: Cannot find module './dashboard-pusher.js'`. The dashboard port stops
listening once the host restarts.
