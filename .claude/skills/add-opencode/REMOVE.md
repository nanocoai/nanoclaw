# Remove OpenCode

Before removing code, switch each OpenCode group to an installed provider using
`ncl groups config update --id <group-id> --provider claude`, then restart that
group. Use `/migrate-memory` first if needed. Do not edit materialized
`container.json` files or clear database rows directly.

Delete `import './opencode.js';` from these five barrels, leaving other imports:

- `setup/providers/index.ts`
- `src/providers/index.ts`
- `src/provider-contracts/index.ts`
- `container/agent-runner/src/providers/index.ts`
- `container/agent-runner/src/provider-contracts/index.ts`

Delete each skill-owned destination in the `nc:copy` block of [SKILL.md](SKILL.md).
Use the destination at the project root, not the source under `payload/`. Check
the applied skill version and ownership before deleting: preserve unrelated files
and local work, and leave shared registry, contract, memory, and cwd-shim files in
place. The install journal records which files the automatic apply actually wrote.

Also remove `src/opencode-dockerfile.test.ts`, the legacy skill-owned guard from
before the `cli-tools.json` migration:

```bash
rm -f src/opencode-dockerfile.test.ts
```

If an older skill version installed the memory plugin and managed config, remove
those unused skill-owned files too, including ignored generated dependencies:

```bash
rm -f container/agent-runner/src/providers/opencode-memory-plugin.ts
rm -f container/agent-runner/src/providers/opencode.compaction.test.ts
rm -rf container/agent-runner/src/providers/opencode-managed-config
```

Recreating affected containers discards their old managed config symlinks. Leave
other tools' config and persisted session data alone.

If an older skill version installed `src/opencode-cli-tools.test.ts`, delete
that legacy skill-owned test as well.

Remove the runner dependency with `cd container/agent-runner && bun remove
@opencode-ai/sdk`. Delete only the object named `opencode-ai` from
`container/cli-tools.json`. Both package and lockfile must be updated together.

If `DEFAULT_AGENT_PROVIDER=opencode` is saved in `.env`, change only that key to
`claude` (or another installed provider) before restarting the host. Then remove
OpenCode-specific `.env` settings that are no longer used. Keep
`ANTHROPIC_BASE_URL` if another integration still needs it. Session state,
memory, and OneCLI secrets are user data: retain them unless the operator
explicitly requests deletion. The fixed credential stub may remain unused.

Run the host build and runner typecheck, then `./container/build.sh build` to
remove the baked SDK and CLI from the local image. Restart the NanoClaw host
using the installation's normal service workflow. Verify that no OpenCode
import remains in any of the five barrels and neither dependency manifest
contains its OpenCode entry. An uninstalled provider fails in the runner; the
host can first warn and compose default surfaces. Switch affected groups before
removing the skill.

The host helper is removed with the payload. Remove `data/host-harness/opencode/`
only if this installation created it and the operator wants its private CLI
removed. Preserve globally installed OpenCode, native credentials, configuration,
and conversation history. Existing native OpenCode can still run in this checkout.
