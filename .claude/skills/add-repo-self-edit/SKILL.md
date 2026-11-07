---
name: add-repo-self-edit
description: Let chosen agents propose edits to NanoClaw's own source as a git patch. Every edit is admin-approved with the full diff on the card, committed with only its own files, checked, restarted, and reverted automatically if a check or the restart fails. Use when the user wants an agent to fix or extend NanoClaw itself from chat.
---

# Add Repo Self-Edit

Adds a `propose_repo_edit` tool for the agent groups you choose. The agent sends a `git diff`-format patch; an admin sees the whole patch on an approval card; only on approval does the host apply it to this checkout. The agent never gets write access to the source.

## Safety model

- **Approval gate.** A proposal goes through the guard like `install_packages` and `add_mcp_server`: held for the agent group's admin chain (scoped admins, then global admins, then owners). The card shows the entire patch, escaped and fenced; a patch too large for one card is refused, never truncated. Agent groups not listed in `REPO_SELF_EDIT_AGENT_GROUPS` are denied before any card is sent. The guard re-runs on the approved replay, so delisting a group also stops an approval already in flight.
- **Re-checked at apply time.** The patch is validated when proposed and again when approved, against the tree as it is then: it must apply cleanly, and no file it touches may carry uncommitted changes.
- **Editable paths.** `src/`, `container/agent-runner/src/`, `container/skills/`, `docs/`. The list is `EDITABLE_PREFIXES` in `src/modules/repo-self-edit/policy.ts`.
- **Never editable.** `.env` files; anything git ignores (`data/`, `logs/`, `groups/` state, `node_modules/`); `package.json`, lockfiles, the Dockerfile and everything else outside the editable paths; and the machinery that makes approval meaningful — the guard, approvals, permissions, mount security, the credential gateway, the env reader, the upgrade marker, delivery, and this skill's own files (`PROTECTED_PREFIXES` in `policy.ts`). Renames, symlinks, mode changes and binary patches are refused.
- **Commits.** Only the patch's own files are staged and committed (`git commit -- <files>`), under the author `NanoClaw self-edit`. Other staged or unstaged work in the checkout is left alone. Each commit re-stamps the upgrade marker, so the startup tripwire accepts it.
- **Rollback.**
  - `container/` edits: the agent-runner typecheck runs first. On failure the commit is undone with a revert commit and nothing restarts. On success the group's containers restart onto the new source.
  - `src/` edits: `scripts/repo-self-edit-watchdog.sh` runs detached from the host. It builds, restarts the service, and requires the host to answer and stay the same instance through a settle window. A failed build, a host that does not come up, or a crash loop makes it commit the reverse of the edit's files, rebuild and restart on the previous code. The host reports the verdict to the agent once it is back.
  - A rollback is always a new commit — never `git reset --hard`. If the reverse patch no longer applies, the agent is told the checkout needs a human.
- **One at a time.** A lock under `data/` refuses new proposals while a host edit is in flight (stale after 30 minutes).

## Phase 1: Pre-flight

Check whether the skill is already applied:

```bash
test -f src/modules/repo-self-edit/index.ts && echo "Already applied" || echo "Not applied"
```

If already applied, run Phase 2 again — every step overwrites or skips-if-present — then continue to Phase 3.

## Phase 2: Apply

### 1. Copy the payload

```bash
S=.claude/skills/add-repo-self-edit/payload
mkdir -p src/modules/repo-self-edit
cp $S/src/modules/repo-self-edit/*.ts src/modules/repo-self-edit/
cp $S/container/agent-runner/src/mcp-tools/repo-self-edit.ts \
   $S/container/agent-runner/src/mcp-tools/repo-self-edit.test.ts \
   $S/container/agent-runner/src/mcp-tools/repo-self-edit.instructions.md \
   container/agent-runner/src/mcp-tools/
cp $S/scripts/repo-self-edit-watchdog.sh scripts/
chmod +x scripts/repo-self-edit-watchdog.sh
```

### 2. Register the host module

In `src/modules/index.ts`, add this line directly after `import './self-mod/index.js';`, if it is not already there:

```typescript
import './repo-self-edit/index.js';
```

It must load after `import './approvals/index.js';` — it registers an approval handler at import time.

### 3. Register the MCP tool

In `container/agent-runner/src/mcp-tools/index.ts`, add this line directly after `import './self-mod.js';`, if it is not already there:

```typescript
import './repo-self-edit.js';
```

The tool's `repo-self-edit.instructions.md` is picked up automatically: every `*.instructions.md` beside the MCP tools is composed into each agent's instructions at spawn.

### 4. Verify

```bash
pnpm run typecheck
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm exec vitest run src/modules/repo-self-edit/ src/guard/conformance.test.ts
(cd container/agent-runner && bun test src/mcp-tools/repo-self-edit.test.ts)
```

- `repo-self-edit.test.ts` (host) imports the real modules barrel and asserts the delivery action, its approval continuation and its guard entry are registered; it then drives a proposal through the real guard, approval card and approved replay into a throwaway git repo — commit, typecheck-failure revert, watchdog hand-off, and every refusal.
- `watchdog.test.ts` runs the real watchdog script with a stubbed build and restart: kept on success, reverted on a failed build and on a crash loop.
- `repo-self-edit.test.ts` (container) asserts the barrel imports the tool and that the tool writes the `repo_self_edit` action through a real MCP client.
- `src/guard/conformance.test.ts` fails if the held action has no approval handler.

## Phase 3: Configure

### Choose the agent groups

Find the agent group id(s):

```bash
ncl groups list
```

Ask the user which groups may propose edits. Add them to `.env`, comma-separated:

```bash
REPO_SELF_EDIT_AGENT_GROUPS=<agent-group-id>[,<agent-group-id>...]
```

The list is read on every proposal — changing it needs no restart. Removing a group stops its proposals and any of its approvals still pending.

### Give the agent something to read

The agent writes patches against source it can see. It already sees the agent-runner source read-only at `/app/src`. To let it propose host changes, mount `src/` read-only — **never the project root**, which holds `.env` and `data/`. Add the directory as a read-only root with `/manage-mounts`, then:

```bash
ncl groups config add-mount --id <agent-group-id> --host "$PWD/src" --container nanoclaw-src --ro
ncl groups restart --id <agent-group-id>
```

It appears in the container at `/workspace/extra/nanoclaw-src`.

### Restart

```bash
pnpm run build
bash setup/lib/restart.sh
```

## Phase 4: Try it

Ask a listed agent for a small docs change, e.g. "fix a typo in docs/architecture.md with propose_repo_edit". The admin gets a "Source Edit Request" card showing the patch. Approve it and check:

```bash
git log -1 --format='%an %s'   # NanoClaw self-edit  self-edit: ...
```

Host edits log the watchdog's run to `logs/repo-self-edit-watchdog.log`.

## Troubleshooting

### `repo_self_edit denied: agent group ... is not listed`

The group id is missing from `REPO_SELF_EDIT_AGENT_GROUPS` in `.env`. Compare against `ncl groups list`.

### `has uncommitted changes on the host`

Someone has local edits in a file the patch touches. Commit or discard them on the host, then ask the agent to propose again.

### `the patch does not apply to the current tree`

The agent's copy of the file is stale, or the patch was hand-written. Have it rebuild the patch from the current file contents.

### A host edit never reports back

Read `logs/repo-self-edit-watchdog.log`. On Linux with systemd the watchdog runs as a transient `systemd-run --user` unit so a service restart does not kill it; without `systemd-run` it runs detached, and a service manager that kills the whole control group on restart will stop it — the lock then expires after 30 minutes and the last commit stays in place unverified. Check `git log` and `bash setup/lib/restart.sh` by hand.

### `reverting ... also failed`

The reverse patch no longer applies, usually because the same files changed again. Resolve by hand: `git log` shows the `self-edit:` commit; revert it or fix forward, then run `pnpm exec tsx scripts/upgrade-state.ts set` and restart.
