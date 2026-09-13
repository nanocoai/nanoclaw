# Remove pr-factory-core

Reverses every change the apply made. Remove dependent components first: `gh-action-approval`, `vm-test-orchestrator`, and `slack-canvas` all import this component's seam files and break the build once these files are gone.

## 1. Delete the copied files

```bash
rm -rf src/modules/pr-factory
rm -f src/db/pr-threads.ts
rm -f src/db/migrations/module-pr-factory-pr-threads-v2.ts
rm -f src/db/pr-threads.test.ts
rm -f src/db/sessions-approval-helpers.test.ts
rm -f src/modules/approvals/response-handler-reject.test.ts
rm -f container/agent-runner/src/mcp-tools/pr-factory.ts
rm -f container/agent-runner/src/mcp-tools/pr-factory-registration.test.ts
rm -f container/agent-runner/src/mcp-tools/pr-factory-tools.test.ts
```

(`rm -rf src/modules/pr-factory` removes the module's five tests along with the sources.)

## 2. Delete the barrel lines

- `src/modules/index.ts` — delete the line `import './pr-factory/index.js';`
- `container/agent-runner/src/mcp-tools/index.ts` — delete the line `import './pr-factory.js';`
- `src/db/migrations/index.ts` — delete the `modulePrFactoryPrThreadsV2` import line and its entry in the `migrations` array.

## 3. Delete the sessions.ts helpers

In `src/db/sessions.ts`, delete the four functions the apply appended: `getPendingApprovalsBySessionAction`, `getPendingApprovalsBySession`, `updatePendingApprovalPlatformMessageId`, `deletePendingApprovalsBySessionAction`. (First confirm nothing else now imports them: `grep -rn 'PendingApprovalsBySession\|updatePendingApprovalPlatformMessageId' src/ --include='*.ts'` should return only sessions.ts.)

## 4. Uninstall the dependency

```bash
pnpm remove undici
```

## 5. Remove the environment lines

Delete from `.env` (the GitHub webhook then 404s — also delete the webhook in the GitHub repo settings):

```
GITHUB_WEBHOOK_SECRET
PR_FACTORY_SLACK_CHANNEL_ID
PR_FACTORY_SUPERVISOR_SLACK_CHANNEL_ID
PR_FACTORY_DEFAULT_REPO
PR_FACTORY_REPO_MIRROR_DIR
PR_FACTORY_REVIEW_SKILL
```

## 6. Data and DB choreography (read before deleting anything)

- **Migration row**: `module-pr-factory-pr-threads-v2` stays recorded in `schema_version` forever, harmlessly — the runner dedupes by name and nothing re-reads it. Do NOT delete the row; a future re-apply relies on name-keyed dedupe semantics either way.
- **`pr_threads` table**: dropping it is data-destructive (it is the only index from PR numbers to threads/sessions). Leave it in place unless you are certain the install never returns to PR Factory; then drop it through the sanctioned query wrapper — `pnpm exec tsx scripts/q.ts data/v2.db "DROP TABLE pr_threads;"` — in a maintenance window, never while the host is running (and never via the `sqlite3` binary).
- **Agent groups / messaging groups / wirings**: bootstrap-created rows (`pr-factory-worker`, `pr-factory-supervisor` agent groups; the PR-channel messaging groups for the `slack`, `slack-supervisor`, `slack-tester` instances; the supervisor admin-channel group) are operator data — remove them with `pnpm run ncl` group/wiring verbs if desired. The seeded `groups/pr-factory-worker/CLAUDE.local.md` and `groups/pr-factory-supervisor/CLAUDE.local.md` may carry operator edits; archive before deleting.
- **Pending approvals**: any open `pr_*` cards become dead clicks after removal. Resolve or dismiss outstanding cards before stopping the module, or delete the rows through the sanctioned query wrapper — `pnpm exec tsx scripts/q.ts data/v2.db "DELETE FROM pending_approvals WHERE action LIKE 'pr_%';"` — and accept the stale Slack cards.
- **Activity logs**: `data/pr-activity/` is append-only operator data; keep or archive.

## 7. Rebuild and restart

```bash
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
```

## 8. Validate

> **Skip this step during full-recipe removal.** When you are removing the whole PR Factory (per the recipe REMOVE.md), the other components are still mid-teardown and reference seams this component owns — a build here is expected to be red. Only the recipe-level validation at the end binds. Run the block below only when removing `pr-factory-core` in isolation.

```bash
pnpm run build && pnpm test
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd container/agent-runner && bun test; cd ../..
```

All suites green, with the pr-factory tests gone from the run.
