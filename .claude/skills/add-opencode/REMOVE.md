# Remove OpenCode provider

Idempotent — safe to run even if some steps were never applied. Reverses both
provider trees, the agent-runner dependency, and the global CLI manifest entry.

## 1. Delete the barrel import lines (both trees)

Delete (do not comment out) the `import './opencode.js';` line from each barrel:

- `src/providers/index.ts`
- `container/agent-runner/src/providers/index.ts`

This unregisters the provider from both `listProviderContainerConfigNames()` (host) and `listProviderNames()` (container).

## 2. Delete the copied files (both trees)

```bash
rm -f src/providers/opencode.ts \
      src/providers/opencode-registration.test.ts \
      src/opencode-cli-tools.test.ts \
      container/agent-runner/src/providers/opencode.ts \
      container/agent-runner/src/providers/mcp-to-opencode.ts \
      container/agent-runner/src/providers/mcp-to-opencode.test.ts \
      container/agent-runner/src/providers/opencode.attachments.test.ts \
      container/agent-runner/src/providers/opencode.compaction.test.ts \
      container/agent-runner/src/providers/opencode.config.test.ts \
      container/agent-runner/src/providers/opencode.factory.test.ts \
      container/agent-runner/src/providers/opencode.memory.test.ts \
      container/agent-runner/src/providers/opencode.question.test.ts \
      container/agent-runner/src/providers/opencode-registration.test.ts
```

## 3. Remove the agent-runner dependency

`@opencode-ai/sdk` is an importable package in the container tree (agent-runner is a Bun package, not a pnpm workspace — use `bun remove`):

```bash
cd container/agent-runner && bun remove @opencode-ai/sdk && cd -
```

## 4. Remove the global CLI manifest entry

Delete the object whose `name` is `opencode-ai` from
`container/cli-tools.json`. Leave every other CLI entry untouched.

## 5. Unset OpenCode env vars

Remove any OpenCode-specific lines you added to `.env` (`OPENCODE_PROVIDER`, `OPENCODE_MODEL`, `OPENCODE_SMALL_MODEL`, and `ANTHROPIC_BASE_URL` if no other integration uses it) if no other integration needs them.

Switch any group still on OpenCode back to the default provider — set `"provider": "claude"` in `groups/<folder>/container.json` and clear `agent_provider` on the group/session in the DB.

## 6. Rebuild and restart

Run from your NanoClaw project root:

```bash
pnpm run build && ./container/build.sh
source setup/lib/install-slug.sh

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)

# Linux
systemctl --user restart $(systemd_unit)
```

> If the rebuild still reports OpenCode after these steps, the buildkit COPY cache may be stale. Prune the builder and rebuild: `docker builder prune -f && ./container/build.sh`.

## Verification

After removal, the registration guards no longer apply (their files are gone). Confirm the provider is fully unwired:

```bash
grep -R "opencode.js" src/providers/index.ts container/agent-runner/src/providers/index.ts   # no output
grep "@opencode-ai/sdk" container/agent-runner/package.json                                   # no output
grep '"opencode-ai"' container/cli-tools.json                                                  # no output
```

In a wired agent, requesting `agent_provider = 'opencode'` should fall back to the default provider since `opencode` is no longer in the registry.
