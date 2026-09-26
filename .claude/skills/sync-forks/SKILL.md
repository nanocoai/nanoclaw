---
name: sync-forks
description: Sync your private fork with public fork(s). Push sanitized changes to a public fork, or pull community contributions back. Triggers on "sync forks", "sync fork", "push to fork", "pull from fork".
---

# About

You maintain a private fork (origin) where you work day-to-day, and one or more public forks that the community uses. This skill keeps them in sync — pushing sanitized improvements out, or pulling community contributions back.

The chain is: `upstream` (community) → your private fork → **public fork(s)** → end users

Run `/sync-forks` in Claude Code.

## How it works

**Fork discovery**: any git remote that isn't `origin` (private fork) or `upstream` (community upstream) is a public fork candidate. One fork skips selection; multiple forks prompts a choice.

**Push flow**: creates a staging branch from the public fork. Merges upstream individually (preserves community attribution), squashes private fork commits (no private history leaks), runs a privacy scan (hard gate), validates the build, then opens a PR or pushes directly.

**Pull flow**: merges the public fork's latest into your private fork. No privacy scanning needed — public → private is safe. Useful when someone else contributes to your public fork.

**Privacy**: private files are restored to public fork templates before committing. A grep scan runs as a safety net for anything the manifest doesn't cover. Both happen before the commit, so personal data never enters the public fork's history.

## Rollback

Push is always on a disposable staging branch — your private fork's main is never touched:
```
git checkout main && git branch -D sync-forks/<fork>/<slug>
```

Pull creates a backup before merging:
```
git reset --hard <backup-tag>
```

## Token usage

Only opens files to apply section restores or fix scan failures. Uses `git log`, `git diff`, `git status`, and `git checkout` for everything else. Does not scan or refactor unrelated code.

---

# Privacy Manifest

<!-- Edit this section with YOUR identifiers before first use. -->

These identifiers drive the safety scan during push.

## Hard Identifiers

Push will not proceed if any of these appear in the diff. Auto-fix, re-scan until clean.

```
# Add your identifiers, one per line. Examples:
# assistant@example.com
# principal@example.com
# sk-ant-XXXXX
# GOCSXX-
# 123456789
# 555-123-4567
# 123 Main St
```

When scanning, join all uncommented lines into a single grep regex with `|`.

## Soft Identifiers

Flag for review. Fix clear references, ask user about ambiguous ones.

```
# Add your identifiers, one per line. Examples:
# Assistant Name
# Principal Name
# example\.com
# my-private-fork
```

## Replacements

When fixing leaks: emails → `{ASSISTANT_EMAIL}` / `{PRINCIPAL_EMAIL}`, names → `{ASSISTANT_NAME}` / `{PRINCIPAL_NAME}`, tokens/secrets/IDs/phone/address → remove entirely.

## Private Files

Files where your private fork has personal data but the public fork has templates. During push, these are restored BEFORE committing.

**Full restore** (entire file reverted to public fork's version via `git checkout <fork>/<branch> -- <path>`):
- *(add files where your fork has personal data but the public fork has a template)*

**Section restore** (personal sections replaced with public fork's template; generic improvements pass through):
- *(add files + section boundaries, format: `path` — `## Start Heading` through `## End Heading`)*

**Exclude** (private-fork-only, unstaged before commit):
- `.claude/skills/sync-forks/`
- *(add other private-fork-only files/dirs)*

When the safety scan fires on a file not in this list, fix it and add the file here so it's automatic next time.

<!-- End of Privacy Manifest — everything below this line is the skill logic and should not need editing. -->

---

# Goal
Safely sync your private fork with public fork(s) — push sanitized improvements out, pull community contributions back — with zero tolerance for personal data leakage on push.

# Operating principles
- Never proceed with a dirty working tree.
- Always create a staging branch for push — never modify the public fork's main directly.
- Upstream commits merge individually (community attribution). Private fork commits squash (no private history).
- Private files are handled declaratively. Grep is the safety net, not the primary mechanism.
- Keep token usage low: rely on `git status`, `git log`, `git diff`, and open only files that need manifest rules or scan fixes.

# Step 0: Preflight (stop early if unsafe)
Run:
- `git status --porcelain`
If output is non-empty:
- Tell the user to commit or stash first, then stop.

Confirm `upstream` remote:
- `git remote -v`
If `upstream` is missing:
- Ask the user for the community upstream URL (default: `https://github.com/qwibitai/nanoclaw.git`).
- `git remote add upstream <url>`

Fetch upstream:
- `git fetch upstream --prune`

# Step 1: Fork discovery
List all remotes:
- `git remote -v`

Identify public fork candidates: any remote that is NOT `origin` and NOT `upstream`. Store the list as FORKS.

If no candidates found:
- Ask the user to add one: `git remote add <name> <url>`
- Re-list remotes.

If exactly one candidate:
- Select it automatically. Tell the user which fork was detected. Store as FORK.

If multiple candidates:
- List them with name + URL.
- Ask the user which fork to sync with using AskUserQuestion. Include an "all" option for pull mode.
- Store selection as FORK (or FORKS for multi-fork pull).

Fetch the selected fork(s):
- `git fetch <fork> --prune`

Detect the fork's default branch:
- Check for `<fork>/main` or `<fork>/master`.
- Store as FORK_BRANCH for all subsequent commands. Every command below that references `<fork>/main` should use `<fork>/$FORK_BRANCH` instead.

Derive the GitHub owner/repo from the remote URL for `gh` commands:
- Parse `https://github.com/<owner>/<repo>.git` or `git@github.com:<owner>/<repo>.git`
- Store as FORK_REPO (e.g., `owner/repo`).

# Step 2: Direction (push or pull)
Show divergence in both directions:
- `git log --oneline HEAD..<fork>/$FORK_BRANCH` (what the fork has that you don't)
- `git log --oneline <fork>/$FORK_BRANCH..HEAD` (what you have that the fork doesn't)

Ask the user to choose a direction using AskUserQuestion:
- A) **Push** — push sanitized changes from your private fork to `<fork>`
- B) **Pull** — pull changes from `<fork>` into your private fork
- C) **Abort** — just view divergence, change nothing

If Abort: stop here.
If Pull: jump to Step P1.
If Push: continue to Step 3.

---

# Push Flow

# Step 3: Optional upstream sync
Ask the user using AskUserQuestion:
- A) **Sync upstream first**: pull latest upstream into your private fork before pushing to the public fork
- B) **Skip**: proceed with current state

If A: offer to run the appropriate update skill (e.g., `/update-nanoclaw`), or do a manual `git merge upstream/main`. After it completes, re-fetch:
- `git fetch <fork> --prune`
- `git fetch upstream --prune`

# Step 4: Preview what changed (categorize and confirm)
Show upstream commits not yet in the public fork:
- `git log --oneline <fork>/$FORK_BRANCH..upstream/main`

Show changed files vs the public fork:
- `git diff --name-only <fork>/$FORK_BRANCH HEAD`

Categorize each changed file using the Private Files lists from the Privacy Manifest:
- **Private (auto-handled):** files in the manifest — will be restored, section-restored, or unstaged
- **Will sync:** everything else, bucketed by area:
  - **Source** (`src/`): core code changes
  - **Container** (`container/`): Dockerfile, agent-runner changes
  - **Skills** (`.claude/skills/`): new or updated skills
  - **Groups** (`groups/`): procedure docs, CLAUDE.md files
  - **Build/config** (`package.json`, `.github/`): review needed
  - **Other**: docs, tests, misc

Present the categorization to the user and ask them to choose one path using AskUserQuestion:
- A) **Full sync**: proceed with this categorization
- B) **Exclude more**: specify additional files to skip for this run
- C) **Abort**: just view, change nothing

If Abort: stop here.

# Step 5: Create staging branch
Create a staging branch with a descriptive name based on the changes from Step 4:
- `STAGING=sync-forks/<fork-name>/<short-slug>` — e.g., `sync-forks/gws-ea/calendar-fixes`. Keep to 3-5 words, kebab-case. This becomes the PR branch name.
- `git checkout -b $STAGING <fork>/$FORK_BRANCH`

This branch is disposable. All work happens here. Your private fork's main is never modified.

# Step 6: Merge upstream (individual commits, preserves attribution)
If upstream has no new commits (`git log --oneline <fork>/$FORK_BRANCH..upstream/main` is empty):
- Skip this step.

- Dry-run merge to preview conflicts. Run as a single chained command so the abort always executes:
  ```
  git merge --no-commit --no-ff upstream/main; git diff --name-only --diff-filter=U; git merge --abort
  ```
- If conflicts were listed: show them and ask user if they want to proceed.
- If no conflicts: tell user it is clean and proceed.

Run:
- `git merge upstream/main --no-edit`

If conflicts occur:
- Run `git status` and identify conflicted files.
- For each conflicted file:
  - Open the file.
  - Resolve only conflict markers.
  - Preserve the public fork's content where appropriate (this is the public fork's repo).
  - Do not refactor surrounding code.
  - `git add <file>`
- `git commit --no-edit`

# Step 7: Squash merge private fork (one commit, no private history)
- Dry-run merge to preview conflicts. Run as a single chained command so the abort always executes:
  ```
  git merge --no-commit --no-ff main; git diff --name-only --diff-filter=U; git merge --abort
  ```
- If conflicts were listed: show them. Note that conflicts in private files don't matter — they'll be overwritten in Step 8. Just pick either side for those.
- If no conflicts: proceed silently.

Run:
- `git merge --squash main`

If conflicts occur:
- Run `git status` and identify conflicted files.
- For each conflicted file:
  - If it's in the private files list: pick either side — it'll be overwritten in Step 8.
  - Otherwise: open the file, resolve conflict markers, `git add <file>`.

DO NOT commit yet — proceed to Step 8.

# Step 8: Privacy (restore private files + safety scan)
All of this runs on the staged but uncommitted squash merge. No commit is created until everything is clean.

**Restore private files:**
For each file in the Private Files lists from the Privacy Manifest:
- **Full restore:** `git checkout <fork>/$FORK_BRANCH -- <path>` then `git add <path>`
- **Section restore:** read the public fork's version (`git show <fork>/$FORK_BRANCH:<path>`), extract the section between the two headings, replace that section in the working copy, `git add <path>`
- **Unstage:** if the public fork has the file: `git checkout <fork>/$FORK_BRANCH -- <path>`. If not: `git rm --cached <path> 2>/dev/null`

Also apply any one-time exclusions from Step 4.

**Safety scan (hard gate):**
Run on `git diff --cached`. If the private files list is current, this finds nothing.

Build the hard identifier regex from the Privacy Manifest (all lines in the Hard Identifiers block, joined with `|`):
```bash
git diff --cached | grep -inE '<hard_identifier_regex>'
```

Build the soft identifier regex from the Privacy Manifest:
```bash
git diff --cached | grep -inE '<soft_identifier_regex>'
```

Hard identifiers: auto-fix, re-scan until clean, suggest adding the file to the private files list.
Soft identifiers: fix clear references, ask user about ambiguous ones.

Apply the Replacements rules from the Privacy Manifest when fixing.

DO NOT commit until both scans pass.

**Commit:**
Once the staged diff is clean:
- `git commit -m "sync: <concise summary>"` — draft the message from the actual file changes, not from the private fork's commit log.

Also scan commit messages:
```bash
git log --format='%s%n%b' <fork>/$FORK_BRANCH..HEAD | grep -inE '<hard_identifier_regex>|<soft_identifier_regex>'
```
If matches: `git reset --soft <fork>/$FORK_BRANCH` and recommit with a clean message.

# Step 9: Validation
Run:
- `npm run build`
- `npm test` (do not fail the flow if tests are not configured)

If build fails:
- Show the error.
- Only fix issues caused by the merge or scrubbing (e.g., missing imports from removed personal code).
- Do not refactor unrelated code.
- If unclear, ask the user before making changes.

# Step 10: Push (PR or direct)
Show summary:
- Upstream commits included: count + `git log --oneline <fork>/$FORK_BRANCH..upstream/main`
- Fork sync commit: message + `git diff --stat` of that commit
- Private files handled (list which rules were applied)
- Safety scan: PASSED
- Build: PASSED

Ask the user to choose using AskUserQuestion:
- A) **Create PR** (recommended): push staging branch, open a PR against the public fork for review
- B) **Push directly**: push to the public fork's main branch (skip PR)
- C) **Review diff**: show full `git diff <fork>/$FORK_BRANCH..HEAD` one more time
- D) **Abort**: delete staging branch, change nothing

If Abort:
- `git checkout main && git branch -D $STAGING`
- Stop.

If Create PR:
- `git push <fork> $STAGING`
- Create PR with `gh pr create --repo $FORK_REPO --base $FORK_BRANCH --head $STAGING` with a summary of changes and privacy scan status.
- Before submitting: scan the PR title and body for soft identifiers. Use "fork" where you'd say the private fork name.
- Return the PR URL.

If Push directly:
- `git push <fork> HEAD:$FORK_BRANCH`

# Step 11: Cleanup + summary
Switch back to main:
- `git checkout main`

If pushed directly (not PR), delete staging branch:
- `git branch -d $STAGING`

If PR was created, keep the staging branch alive until merged. Tell the user they can delete it after merging:
- `git branch -d $STAGING`

Update local tracking:
- `git fetch <fork> --prune`

Show:
- What was pushed/PR'd: upstream commits (count) + sync commit (summary)
- Private files restored (count)
- If PR: the PR URL

Tell the user:
- End users can pull these changes with the appropriate update skill (after PR is merged, if applicable).

---

# Pull Flow

# Step P1: Create a safety net
Capture current state:
- `HASH=$(git rev-parse --short HEAD)`
- `TIMESTAMP=$(date +%Y%m%d-%H%M%S)`

Create backup branch and tag:
- `git branch backup/pre-pull-$HASH-$TIMESTAMP`
- `git tag pre-pull-$HASH-$TIMESTAMP`

Save the tag name for rollback instructions in the summary.

# Step P2: Preview what changed
Show what the public fork has that your private fork doesn't:
- `git log --oneline HEAD..<fork>/$FORK_BRANCH`

If the public fork has no new commits:
- Tell the user there's nothing to pull. Stop.

- Dry-run merge to show what would actually change in your tree. Run as a single chained command so the abort always executes:
  ```
  git merge --no-commit --no-ff <fork>/$FORK_BRANCH; git diff --stat HEAD; git merge --abort
  ```

If the dry-run shows zero or near-zero file changes:
- Tell the user: "These commits contain changes already in your fork from a previous push — no real file changes to pull."
- Ask using AskUserQuestion:
  - A) **Merge anyway**: sync commit history even though content is identical
  - B) **Abort**: skip, nothing meaningful to pull

If the diff shows real changes, ask the user to choose one path using AskUserQuestion:
- A) **Merge all**: merge all new commits from the public fork
- B) **Cherry-pick**: select specific commits to pull
- C) **Abort**: just view, change nothing

If Abort: stop here.

# Step P3: Merge or cherry-pick
If Merge all:
- `git merge <fork>/$FORK_BRANCH --no-edit`
- If conflicts: resolve them, preserving your private fork's customizations where appropriate (this is your working repo).

If Cherry-pick:
- Show the commit list again: `git log --oneline HEAD..<fork>/$FORK_BRANCH`
- Ask user which commits to pick (by hash or range).
- `git cherry-pick <commits>`
- If conflicts: resolve them.

# Step P4: Validation
Run:
- `npm run build`
- `npm test` (do not fail the flow if tests are not configured)

If build fails:
- Show the error and fix issues caused by the merge.
- Do not refactor unrelated code.
- If unclear, ask the user before making changes.

# Step P5: Summary + rollback instructions
Show:
- Backup tag: the tag name created in Step P1
- Commits pulled: count + summary
- Conflicts resolved (list files, if any)
- Build: PASSED

Tell the user:
- To rollback: `git reset --hard <backup-tag-from-step-P1>`
- Backup branch also exists: `backup/pre-pull-<HASH>-<TIMESTAMP>`
- Restart the service to apply changes.

If user selected "all" forks in Step 1 (multi-fork pull):
- Loop back to Step P1 for the next fork.
