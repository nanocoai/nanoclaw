# Remove Dashboard

Safe to re-run even if some pieces are already gone.

```bash
rm -f src/dashboard-pusher.ts src/dashboard-pusher.test.ts src/dashboard-wiring.test.ts
pnpm uninstall @nanoco/nanoclaw-dashboard 2>/dev/null || true
```

Remove the dashboard block from `main()` in `src/index.ts`: the
`// Dashboard (optional…)` comment, the dynamic import, and the
`await startDashboard();` call. Remove `DASHBOARD_SECRET` and
`DASHBOARD_PORT` from `.env`, then run:

```bash
pnpm run build
```
