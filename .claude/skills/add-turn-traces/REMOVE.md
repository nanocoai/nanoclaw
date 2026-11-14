# Remove /add-turn-traces

Reverses every change the apply steps made. Safe to re-run: each step is a no-op when its change is already gone.

### 1. Undo the Claude provider edit

In `container/agent-runner/src/providers/claude.ts`:

1. Delete the line `import { withTurnTraceHooks } from '../modules/turn-traces/claude-hooks.js';`.
2. In `query()`, replace `hooks: withTurnTraceHooks({` with `hooks: {`, and the matching closing `}),` with `},`. Leave the entries inside unchanged.

Then confirm nothing references the module:

```bash
grep -n "withTurnTraceHooks\|turn-traces" container/agent-runner/src/providers/claude.ts
```

This must print nothing.

### 2. Delete the barrel lines

```bash
sed -i.bak "/^import '.\/turn-traces\/index.js';$/d" container/agent-runner/src/modules/index.ts && rm -f container/agent-runner/src/modules/index.ts.bak
sed -i.bak "/^import '.\/turn-traces\/index.js';$/d" src/modules/index.ts && rm -f src/modules/index.ts.bak
```

### 3. Delete the copied files, tests included

```bash
rm -rf container/agent-runner/src/modules/turn-traces src/modules/turn-traces
```

### 4. Remove the setting and the opt-in markers

Delete the `TURN_TRACE_RETENTION_DAYS` line from `.env`, if you added one, and every group's marker:

```bash
rm -f groups/*/turn-traces.enabled
```

### 5. Drop the stored traces

The table holds prompt and tool content, so remove it rather than leave it behind. Stop the service first, then run from the project root:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "DROP TABLE IF EXISTS turn_traces"
pnpm exec tsx scripts/q.ts data/v2.db "DELETE FROM schema_version WHERE name = 'module:turn-traces:create-table'"
```

Deleting the `schema_version` row lets a later re-install create the table again.

### 6. Rebuild and restart

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

Running containers keep the recorder until they respawn (with the markers gone they record nothing, and the host no longer accepts `turn_trace`); `ncl groups restart --id <group-id>` respawns one group now.
