# Remove the PR Factory (recipe)

## 0. Delete the recipe-owned guard tests FIRST

Before touching any component, delete the two composed-stack guard tests. They assert the *whole* stack is present and in sync — so as soon as the first component starts coming out, they go red and every later component's removal runs against a failing test tree:

```bash
rm -f src/recipe-pr-factory-stack.test.ts src/skill-sync.test.ts
```

(`sync-skill-files.sh` and `docs/pr-factory.md` are deleted in the final cleanup step below; only the two `.test.ts` guards must go up front.)

**During full-recipe removal, ignore the `## Validate` step at the end of each component's REMOVE.md** — those per-component builds run mid-teardown, while sibling components still reference seams the current component is removing, so they will be red and that is expected. Only the recipe-level validation at the very end of this file is binding.

## 1. Run the component REMOVE.mds in reverse apply order

Each component's REMOVE.md reverses everything that component installed (files, barrel lines, dependencies, env keys); follow them in this order, skipping components that were never applied — and skipping each one's trailing `## Validate` block per the note above:

1. `skills/slack-canvas/REMOVE.md`
2. `skills/vm-test-orchestrator/REMOVE.md`
3. `skills/gh-action-approval/REMOVE.md`
4. `skills/pr-factory-core/REMOVE.md`
5. `skills/slack-bots/REMOVE.md`
6. `/add-slack`'s removal steps, only if the worker Slack channel itself is being removed.

## 2. Delete the remaining recipe-owned files

```bash
rm -f docs/pr-factory.md
```

`src/skill-sync.test.ts` was already deleted in step 0. The sync script behind it, `scripts/sync-skill-files.sh`, is shared manifest infrastructure: leave it in place if any other skill in the install uses a `files.txt` manifest; if this recipe was the only consumer, remove it too:

```bash
rm -f scripts/sync-skill-files.sh
```

Operator data is not deleted by any of the above — `data/gh-users.json`, `data/pr-activity/`, the repo mirror dir, `groups/pr-factory-worker/`, `groups/pr-factory-supervisor/`, and `groups/pr-tester/` are yours to keep or remove. The `pr_threads` table and the recorded component migrations stay in the central DB (migrations are forward-only); they are inert without the module.

Validate: `pnpm run build && pnpm test` — both green.
