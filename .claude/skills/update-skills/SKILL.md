---
name: update-skills
description: Re-apply your installed skills to pull their latest code from upstream.
---

# About

Each skill is a self-installing additive unit: its folder under `.claude/skills/<name>/` carries its own apply steps (`SKILL.md`), and channel/provider skills fetch their code files from a long-lived upstream branch (`channels`, `providers`) with `git fetch origin <branch>` + `git show origin/<branch>:path > path`. Every apply is idempotent and safe to re-run.

Updating a skill means **re-running its own apply**. The apply re-fetches the latest files from upstream and overwrites the copied-in code, so newer versions land additively.

Run `/update-skills` in Claude Code.

## How it works

**Preflight**: checks for a clean working tree and the upstream remote.

**Detection**: reads the channel and provider barrels to list which skills have copied code into your tree, and lists the operational/utility skills present under `.claude/skills/`.

**Selection**: presents the installed skills and lets you pick which to re-apply.

**Re-apply**: invokes each selected skill's own apply (e.g. `/add-slack`), which fetches its latest files. Then validates with build + test.

---

# Goal
Help users pull the latest skill code from upstream by re-applying their installed skills, without losing local customizations and without merging any branch.

# Operating principles
- Never proceed with a dirty working tree.
- Re-apply each skill through its own idempotent apply step — re-applying overwrites only that skill's code files; credentials, wiring, and DB state are untouched.
- Keep token usage low: detect installed skills with `git` and barrel reads; let each skill's apply do its own fetching.

# Step 0: Preflight

Run:
- `git status --porcelain`

If output is non-empty:
- Tell the user to commit or stash first, then stop.

Check remotes:
- `git remote -v`

If `origin` does not point at a NanoClaw upstream (or you want to verify it has the skill branches), confirm with the user before continuing. The default upstream is `https://github.com/nanocoai/nanoclaw.git`.

Fetch the branches that carry skill code:
- `git fetch origin channels providers --prune`

# Step 1: Detect installed skills

**Channels** — read `src/channels/index.ts` and collect each `import './<name>.js';` line, excluding `cli`. Each `<name>` maps to the `/add-<name>` skill.

**Providers** — read `src/providers/index.ts` the same way; each imported provider maps to its `/add-<name>` skill.

**Operational and utility skills** — list the folders under `.claude/skills/`. These copy no code into the tree, so "re-applying" them just re-reads their instructions; only include them if the user specifically wants to re-run a workflow.

Build the candidate list from the channels and providers actually wired into the barrels — those are the skills whose copied code can be refreshed from upstream.

# Step 2: Present results

If no channel or provider skills are installed:
- Tell the user there are no code-carrying skills to update. List any operational skills present for reference.
- Stop here.

If installed channel/provider skills are found:
- Show the list (e.g. `slack`, `discord`, `opencode`).
- Use AskUserQuestion with `multiSelect: true` to let the user pick which skills to re-apply.
  - One option per installed channel/provider (e.g. "Re-apply Slack (/add-slack)").
  - Add an option: "Skip — don't update any skills now".
- If the user selects Skip, stop here.

# Step 3: Re-apply each selected skill

For each selected skill (process one at a time):

1. Tell the user which skill is being re-applied.
2. Invoke the corresponding `/add-<name>` skill using the Skill tool.
   - Its apply runs its own pre-flight, fetches the latest files from upstream (`git fetch origin <branch>` + `git show origin/<branch>:path > path`), overwrites the copied-in code, and installs any pinned dependency.
   - Re-applying is additive: it refreshes only that skill's own files. The barrel import line is left in place if already present, and `.env` credentials and DB wiring are untouched.
3. If a skill's apply reports a problem (a missing upstream file, a failing dependency install), record it and continue with the remaining skills.

# Step 4: Validation

After all selected skills are re-applied:
- `pnpm run build`
- `pnpm test` (do not fail the flow if tests are not configured)
- If the re-apply changed any files under `container/` (`git diff --name-only -- container/` is non-empty), rebuild the agent image so new sessions pick up the new code: `./container/build.sh`. Skill code that lives in the container (e.g. a provider's runtime) keeps running the old image until this is done — the rebuild is what makes the fix live, not the file copy. If nothing under `container/` changed (e.g. only a channel adapter was re-applied), skip it.

Each channel/provider skill copies in its own registration test; those run as part of `pnpm test` and assert the barrel still registers the adapter against the freshly fetched code.

If build fails:
- Show the error.
- Only fix issues clearly caused by the refreshed code (missing imports, type mismatches).
- Do not refactor unrelated code.
- If unclear, ask the user.

# Step 5: Summary

Show:
- Skills re-applied (list)
- Skills skipped or that reported problems (if any)
- New HEAD: `git rev-parse --short HEAD`

If the service is running, remind the user to restart it to pick up the refreshed code.
