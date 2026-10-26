# Remove scheduler container cap

Delete `import './scheduler-cap/index.js';` from `src/modules/index.ts`, leaving other imports.

Delete the skill-owned files:

```bash
rm -f src/modules/scheduler-cap/cap.ts src/modules/scheduler-cap/cap.test.ts \
  src/modules/scheduler-cap/index.ts src/modules/scheduler-cap/wiring.test.ts
rmdir src/modules/scheduler-cap
```

Remove `SCHEDULER_MAX_CONTAINERS` from `.env`, then rebuild (`pnpm run build`) and restart the host.
