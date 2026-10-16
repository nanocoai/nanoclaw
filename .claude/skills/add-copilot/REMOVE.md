# Remove GitHub Copilot

Before removing code, switch each Copilot group to an installed provider using
`ncl groups config update --id <group-id> --provider claude`, then restart that
group. Memory and workspace files remain on disk.

Delete `import './copilot.js';` from these five barrels, leaving other imports:

- `src/providers/index.ts`
- `src/provider-contracts/index.ts`
- `container/agent-runner/src/providers/index.ts`
- `container/agent-runner/src/provider-contracts/index.ts`
- `setup/providers/index.ts`

Delete every skill-owned destination in the `nc:copy` block of [SKILL.md](SKILL.md).
Use the destination at the project root, not the source under `payload/`. Preserve
unrelated files and local work.

Remove the runner dependency with
`cd container/agent-runner && bun remove @github/copilot-sdk`. Delete only the
object named `@github/copilot` from `container/cli-tools.json`. Both package and
lockfile must be updated together.

If `DEFAULT_AGENT_PROVIDER=copilot` is saved in `.env`, change only that key to
`claude` or another installed provider before restarting the host. Then remove
unused Copilot settings such as `COPILOT_MODEL` and `COPILOT_API_URL`.

Gateway secrets and OneCLI rules are user data. Remove them only when the
operator explicitly requests it. The helper creates secrets named
`Copilot GitHub (copilot_internal)` and `Copilot API`, and a rule named
`Block Copilot individual endpoint`.

Run:

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh build
pnpm test
cd container/agent-runner && bun test
```

Restart the NanoClaw host using the installation's normal service workflow.
Verify that no Copilot import remains in any barrel and neither dependency
manifest contains its Copilot entry.
