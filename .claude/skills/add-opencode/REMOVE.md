# Remove OpenCode

Before removing code, switch each OpenCode group to an installed provider using
`ncl groups config update --id <group-id> --provider claude`, then restart that
group. Use `/migrate-memory` first if needed. Do not edit materialized
`container.json` files or clear database rows directly.

Delete `import './opencode.js';` from these four barrels, leaving other imports:

- `src/providers/index.ts`
- `src/provider-contracts/index.ts`
- `container/agent-runner/src/providers/index.ts`
- `container/agent-runner/src/provider-contracts/index.ts`

Delete exactly the skill-owned copied files below. Leave shared registry,
contract, memory, and cwd-shim files in place.

```bash
rm -f container/agent-runner/src/provider-contracts/opencode.ts
rm -f container/agent-runner/src/providers/mcp-to-opencode.test.ts
rm -f container/agent-runner/src/providers/mcp-to-opencode.ts
rm -f container/agent-runner/src/providers/opencode-config.ts
rm -f container/agent-runner/src/providers/opencode-memory.ts
rm -f container/agent-runner/src/providers/opencode-registration.test.ts
rm -f container/agent-runner/src/providers/opencode-turn.ts
rm -f container/agent-runner/src/providers/opencode.attachments.test.ts
rm -f container/agent-runner/src/providers/opencode.config.test.ts
rm -f container/agent-runner/src/providers/opencode.conformance.test.ts
rm -f container/agent-runner/src/providers/opencode.empty-resume.test.ts
rm -f container/agent-runner/src/providers/opencode.factory.test.ts
rm -f container/agent-runner/src/providers/opencode.memory.test.ts
rm -f container/agent-runner/src/providers/opencode.native.test.ts
rm -f container/agent-runner/src/providers/opencode.question.test.ts
rm -f container/agent-runner/src/providers/opencode.shared-runtime.test.ts
rm -f container/agent-runner/src/providers/opencode.sse-cleanup.test.ts
rm -f container/agent-runner/src/providers/opencode.ts
rm -f container/agent-runner/src/providers/opencode-auth.ts
rm -f container/agent-runner/src/providers/opencode-auth.test.ts
rm -f scripts/opencode-auth-config.test.ts
rm -f scripts/opencode-auth.test.ts
rm -f scripts/opencode-auth.ts
rm -f scripts/opencode-model-config.ts
rm -f scripts/opencode-models.test.ts
rm -f scripts/opencode-models.ts
rm -f scripts/opencode-vault.test.ts
rm -f scripts/opencode-vault.ts
rm -f scripts/tsconfig.opencode-auth.json
rm -f src/provider-contracts/opencode.ts
rm -f src/providers/opencode-auth-stub.ts
rm -f src/providers/opencode-registration.test.ts
rm -f src/providers/opencode.ts
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
import remains in any of the four barrels and neither dependency manifest
contains its OpenCode entry. An uninstalled provider fails in the runner; the
host can first warn and compose default surfaces. Switch affected groups before
removing the skill.
