# Remove Repo Self-Edit

Idempotent — safe to run even if some steps were never applied. Commits already made by self-edits stay in `git log`; removing the skill does not undo them.

## 1. Delete the copied files

```bash
rm -rf src/modules/repo-self-edit
rm -f container/agent-runner/src/mcp-tools/repo-self-edit.ts \
      container/agent-runner/src/mcp-tools/repo-self-edit.test.ts \
      container/agent-runner/src/mcp-tools/repo-self-edit.instructions.md \
      scripts/repo-self-edit-watchdog.sh
```

## 2. Remove the barrel lines

- In `src/modules/index.ts`, delete `import './repo-self-edit/index.js';`.
- In `container/agent-runner/src/mcp-tools/index.ts`, delete `import './repo-self-edit.js';`.

## 3. Remove configuration and state

- Delete the `REPO_SELF_EDIT_AGENT_GROUPS=` line from `.env`.
- Delete leftover state: `rm -f data/repo-self-edit.lock data/repo-self-edit-result.json logs/repo-self-edit-watchdog.log`.
- If you added a read-only `src/` mount for a group only for this skill, remove it: `ncl groups config remove-mount --id <agent-group-id> --host "$PWD/src" --container nanoclaw-src`, and drop the root from the mount allowlist with `/manage-mounts`.

## 4. Rebuild and restart

```bash
pnpm run typecheck
pnpm run build
bash setup/lib/restart.sh
```

Pending "Source Edit Request" cards become inert: approving one reports that no handler is installed.
