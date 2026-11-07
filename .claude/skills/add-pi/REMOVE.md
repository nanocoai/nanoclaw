# Remove pi

Before removing code, switch each pi group to an installed provider using
`ncl groups config update --id <group-id> --provider claude`, then restart that
group. Use `/migrate-memory` first if needed. Do not edit materialized
`container.json` files or clear database rows directly.

Delete `import './pi.js';` from these five barrels, leaving other imports:

- `setup/providers/index.ts`
- `src/providers/index.ts`
- `src/provider-contracts/index.ts`
- `container/agent-runner/src/providers/index.ts`
- `container/agent-runner/src/provider-contracts/index.ts`

Delete each skill-owned destination in the `nc:copy` block of [SKILL.md](SKILL.md).
Use the destination at the project root, not the source under `payload/`. Check
the applied skill version and ownership before deleting: preserve unrelated files
and local work, and leave shared registry, contract, memory, and MCP files in
place. The install journal records which files the automatic apply actually wrote.

Remove the runner dependency with `cd container/agent-runner && bun remove
@earendil-works/pi-coding-agent`. Package and lockfile must be updated together.

The pin is mirrored outside the lockfile: run `pnpm run skill-pins:generate` so
`.github/skill-pins/package.json` drops the `@earendil-works/pi-coding-agent`
entry. Leaving it behind fails `skill-pins:check` in CI.

If `DEFAULT_AGENT_PROVIDER=pi` is saved in `.env`, change only that key to
`claude` (or another installed provider) before restarting the host, and remove
the pi-specific `PI_GATEWAY_PROVIDERS` setting if no other integration
uses it.

Run the host build and runner typecheck, then `./container/build.sh build` to
drop the baked SDK from the local image. Restart the NanoClaw host using the
installation's normal service workflow. Verify that no pi import remains in any
of the five barrels and that `container/agent-runner/package.json` no longer
lists the pi SDK.

Session state, the group's `.pi-shared` agentDir, and credentials stored in the
gateway are user data: retain them unless the operator explicitly requests
deletion. The group's `.pi-shared` directory can be removed once no group uses
pi, but it must never be deleted automatically.
