# Remove gh-action-approval

Reverses every change the apply made. After removal, `credentialed_gh` calls degrade gracefully: core's seam notifies the agent that the component is not installed.

## 1. Delete the copied files

```bash
rm -f src/modules/pr-factory/gh-action-approval.ts
rm -f src/modules/pr-factory/gh-users.sample.json
rm -f src/modules/pr-factory/gh-action.test.ts
```

## 2. Delete the barrel line

In `src/modules/index.ts`, delete the line `import './pr-factory/gh-action-approval.js';`.

## 3. Remove the environment line

Delete `PR_FACTORY_GH_REPO_ALLOWLIST` from `.env` if present.

## 4. Operator data

`data/gh-users.json` maps real chat handles to gh logins — delete it unless the install will re-apply this component:

```bash
rm -f data/gh-users.json
```

The mapped gh accounts' host logins (`gh auth login`, `~/.config/gh/hosts.yml`) are operator-managed; revoke or keep them per your credential policy.

## 5. Pending cards

Any open `pr_gh` approval cards become dead after removal (the handler is gone). Resolve or dismiss outstanding cards before restarting, or delete the rows through the sanctioned query wrapper — `pnpm exec tsx scripts/q.ts data/v2.db "DELETE FROM pending_approvals WHERE action = 'pr_gh';"` — and accept the stale Slack cards.

## 6. Restart and validate

> **Skip this step during full-recipe removal.** When tearing down the whole PR Factory, the remaining components still reference seams that are being removed — a build mid-teardown is expected to be red. Only the recipe-level validation at the end binds. Run the block below only when removing `gh-action-approval` in isolation.

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
pnpm run build && pnpm test
```

All green, with the gh-action test gone from the run.
