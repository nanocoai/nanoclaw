# Remove the Cursor agent provider

Reverses every change `/add-cursor` makes and returns every group to the default provider. Safe to run when partially installed — skip any step whose target is already absent.

## 1. Switch cursor groups back to the default

List groups still on cursor and switch each one (each group's `memory/` tree stays on disk and readable; run `/migrate-memory` per group if its memory should carry back to Claude — see [docs/provider-migration.md](../../docs/provider-migration.md)):

```bash
ncl groups list
# for each group whose config shows provider=cursor:
ncl groups config update --id <group-id> --provider claude
ncl groups restart --id <group-id>
```

## 2. Delete the barrel imports

Delete (do not comment out) the `import './cursor.js';` line from each of:

- `src/providers/index.ts`
- `src/provider-contracts/index.ts`
- `container/agent-runner/src/providers/index.ts`
- `container/agent-runner/src/provider-contracts/index.ts`
- `setup/providers/index.ts`

## 3. Delete every copied file

```bash
rm -f src/providers/cursor.ts \
      src/providers/cursor-registration.test.ts \
      src/providers/cursor-host-contribution.test.ts \
      src/provider-contracts/cursor.ts \
      container/agent-runner/src/providers/cursor.ts \
      container/agent-runner/src/providers/cursor-auth.ts \
      container/agent-runner/src/providers/cursor-hook.ts \
      container/agent-runner/src/providers/cursor-gateway-probe.ts \
      container/agent-runner/src/providers/cursor-registration.test.ts \
      container/agent-runner/src/providers/cursor.factory.test.ts \
      container/agent-runner/src/providers/cursor-auth.test.ts \
      container/agent-runner/src/providers/cursor-hook.test.ts \
      container/agent-runner/src/providers/cursor.poll-loop.test.ts \
      container/agent-runner/src/providers/cursor.conformance.test.ts \
      container/agent-runner/src/providers/cursor.gateway-proxy.test.ts \
      container/agent-runner/src/provider-contracts/cursor.ts \
      setup/providers/cursor.ts \
      setup/providers/cursor.test.ts \
      setup/providers/cursor-registration.test.ts
```

`container/agent-runner/src/providers/exchange-archive.ts` and its test are shared with the Codex provider; remove them only if `/add-codex` is not installed either.

This skill itself (`.claude/skills/add-cursor/`) stays — it ships with trunk so the provider can be re-added later.

## 4. Remove the agent-runner dependency

```bash
cd container/agent-runner && bun remove @cursor/sdk && cd -
```

Do **not** edit `container/cli-tools.json` — this skill never added a CLI there.

## 5. Vault secrets (optional)

The Cursor secrets in the OneCLI vault grant nothing once the provider is gone. To remove them: `onecli secrets list`, then `onecli secrets delete --id <id>` for both the `api2.cursor.sh/auth/exchange_user_api_key` and `api.cursor.com/v1/models` entries.

## 6. Per-group state (optional)

Each cursor group keeps its Cursor agent store, hooks, and self-authored skills under `data/v2-sessions/<group-id>/.cursor-shared/` and its skill links under `groups/<folder>/.cursor/`. Delete them only if the group will never return to cursor.

## 7. Rebuild and verify

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
pnpm test
cd container/agent-runner && bun test
```

All suites green and `ncl groups list` showing no cursor groups means the removal is complete. Restart the service (`launchctl kickstart -k gui/$(id -u)/<label>` on macOS, `systemctl --user restart <unit>` on Linux).
