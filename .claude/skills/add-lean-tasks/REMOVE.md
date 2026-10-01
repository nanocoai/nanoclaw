# Remove lean task runs

Turn lean mode off on every task that uses it first, so no task keeps fields
nothing reads:

```bash
ncl tasks list
ncl tasks update --id <series-id> --lean false --render none
```

Do this while the skill is still installed: afterwards `ncl` rejects the flags.
The stored `lean` and `render` keys are then inert task data; leave them.

Delete `import './lean-tasks/index.js';` from both barrels, leaving every other
import:

- `src/modules/index.ts`
- `container/agent-runner/src/modules/index.ts`

Delete the copied files, tests included:

```bash
rm -r src/modules/lean-tasks container/agent-runner/src/modules/lean-tasks
```

Run `pnpm run build` and
`pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`, then restart
the host with the installation's normal service workflow. Verify that neither
barrel mentions `lean-tasks`.
