---
name: migrate-nanoclaw
description: Extracts user customizations from a fork, generates a replayable migration guide, and upgrades to upstream by reapplying customizations on a clean base. Replaces merge-based upgrades with intent-based migration.
---

# Context

NanoClaw users fork the repo and customize it — changing config values, editing source files, modifying personas, adding skills. When upstream ships updates or refactors, `git merge` produces painful conflicts because the same core files were changed on both sides.

This skill extracts the user's customizations into a migration guide — capturing both the intent (what they want) and the implementation details (how they did it, with code snippets, API calls, and specific configurations). On upgrade, it checks out clean upstream in a worktree, then reapplies customizations using the guide. No merge conflicts because there's nothing to merge.

The migration guide is markdown, not structured data. It needs to capture the full range of what a user might customize, with enough implementation detail that a fresh Codex session can reapply it without having seen the original code. Standard changes (config values, simple logic) can be described briefly. Non-standard changes (specific APIs, custom integrations, unusual patterns) need code snippets and precise instructions.

Two phases: **Extract** (build the migration guide) and **Upgrade** (use it). If a guide already exists, offer to skip to Upgrade.

# Principles

- Never proceed with a dirty working tree.
- Always create a rollback point (backup branch + tag) before touching anything.
- The migration guide is the source of truth, not diffs.
- Use a worktree to validate before affecting the live install.
- Data directories (`groups/`, `store/`, `data/`, `.env`) are never touched — only code.
- Be helpful: offer to do things (stash, commit, stop services) rather than telling the user to do them.
- **Use sub-agents for exploration.** Spawn haiku sub-agents to explore the codebase, trace skill merges, diff files, and identify customizations. This keeps the main context focused on the user conversation and decision-making.
- **Always use absolute paths in worktrees.** The Bash tool resets the working directory between calls. Never use relative `cd .upgrade-worktree` — always use the full absolute path: `cd /absolute/path/.upgrade-worktree && <command>`. Store the worktree absolute path in a variable at creation time and reference it throughout.
- **Balance exploration and asking.** Don't bombard the user with questions when you can figure things out from the code. Don't burn endless tokens exploring when the user could clarify in one sentence. Use sub-agents to explore first, then ask the user targeted questions about things that are ambiguous or where intent isn't clear from the code alone.
- **Scale effort to complexity.** Not every migration needs the full process. Assess the scope early and take the lightest path that fits.

---

# Phase 1: Extract

## 1.0 Preflight

Run `git status --porcelain`. If non-empty, offer to stash or commit for them (AskUserQuestion: "Stash changes" / "Commit changes" / "I'll handle it"). If they want to commit, stage and commit with a descriptive message. If they want to stash, run `git stash push -m "pre-migration stash"`.

Check remotes with `git remote -v`. If `upstream` is missing, ask for the URL (default: `https://github.com/nanocoai/nanoclaw.git`), add it, then `git fetch upstream --prune`.

Detect upstream branch: check `git branch -r | grep upstream/` for `main` or `master`. Store as UPSTREAM_BRANCH.

## 1.1 Assess scope and determine path

Quickly assess the scale of divergence, check for an existing guide, and determine the right approach — all before asking the user anything.

```bash
BASE=$(git merge-base HEAD upstream/$UPSTREAM_BRANCH)
# Divergence stats
git rev-list --count $BASE..upstream/$UPSTREAM_BRANCH  # upstream commits
git rev-list --count $BASE..HEAD                       # user commits
git diff --name-only $BASE..HEAD | wc -l               # user changed files
git diff --stat $BASE..HEAD | tail -1                   # insertions/deletions
git diff --name-only $BASE..upstream/$UPSTREAM_BRANCH | wc -l  # upstream changed files
```

Check for existing guide: `.nanoclaw-migrations/guide.md` or `.nanoclaw-migrations/index.md`.

**Determine the tier based on the total diff from base:**

### Tier 1: Lightweight — suggest `/update-nanoclaw` instead

Conditions (any of):
- Very few upstream changes (< ~5 commits) AND few user changes (< ~3 changed files)
- User recently updated/migrated (merge-base is close to upstream HEAD)

Tell the user the scope is small and suggest `/update-nanoclaw` might be simpler. Let them choose.

### Tier 2: Standard

Conditions:
- Moderate total diff (3-15 changed files, no large number of new files)
- Manageable scope that fits in a single guide file

### Tier 3: Complex

Conditions (any of):
- Many new files added (indicates many skills applied) — discount files that come purely from skill merges when assessing complexity; a fork with 3 skills and no other changes is simpler than it looks by file count alone
- Deep source changes to core files (`src/index.ts`, `src/container-runner.ts`, etc.) beyond what skills introduced
- Lots of insertions/deletions in user-authored code (not skill-merged code)
- Many skills applied (3+) AND the user confirms or sub-agents find customizations on top of them

Use the full process: multiple sub-agents in parallel, directory-based guide, migration plan.

**Now combine the scope assessment with initial user input in one interaction.** Present the scope summary (how many commits, files, which tier) and ask (AskUserQuestion):

For Tier 1:
- **Use /update-nanoclaw** — simpler merge-based approach
- **Proceed with full migration** — continue

For Tier 2/3 (with or without existing guide):
- If guide exists and is current: **Skip to upgrade** / **Update guide** (add new changes) / **Re-extract from scratch**
- If guide exists but is stale: **Update guide** (recommended) / **Re-extract from scratch** / **Skip to upgrade anyway**
- If no guide: **Yes, let me describe my customizations first** / **Just figure it out** / **A bit of both**

This single interaction replaces what were previously separate steps for scope assessment, user input, and existing guide check.

## 1.2 Update existing guide (if applicable)

If the user chose to update an existing guide rather than re-extract:

1. Read the existing guide
2. Find commits made since the guide was generated (compare guide's recorded base hash against current HEAD)
3. Spawn a haiku sub-agent to analyze only the new changes:
   > Diff HEAD against `<guide-recorded-hash>`. For each changed file, summarize what changed and why.
4. Present the new changes to the user for confirmation
5. Append new customizations to the existing guide, update the header hashes
6. Skip to Phase 2

## 1.3 Explore the codebase

Spawn a haiku sub-agent (Agent tool, model: haiku) for initial exploration:

> Explore this NanoClaw fork to identify all changes from the upstream base. Run these commands and report back:
>
> 1. `git diff --name-only $BASE..HEAD` — all changed files
> 2. `git log --oneline $BASE..HEAD` — all commits (look for skill branch merges like `Merge branch 'skill/*'`)
> 3. `git branch -r --list 'upstream/skill/*'` — available upstream skill branches
> 4. `ls .Codex/skills/` — installed skills
> 5. For each skill merge found, record the merge commit hash
>
> Report: (a) list of applied skills with their merge commit hashes, (b) list of all changed files, (c) any custom skill directories that don't match upstream branches.

From the sub-agent results, identify:
- **Which files came purely from skill merges** — these will be reapplied by re-merging skill branches in Phase 2
- **Everything else** — all remaining changes are customizations to analyze (whether they're on skill-touched files or not)

Don't try to distinguish "user modified a skill file" from "user made their own change" at this stage. The sub-agents in 1.4 will look at all non-skill changes together and surface what matters.

## 1.4 Analyze customizations

For each applied skill, ask the user in a single batched question (AskUserQuestion, multiSelect):

> "I found these applied skills. Select any you customized further after applying:"

Options: one per skill, plus "None — all used as-is".

Then spawn sub-agents to analyze all non-skill changes. For Tier 2, one or two agents. For Tier 3, run in parallel by area:

- **Config + build files** — one sub-agent
- **Source files** (`src/*.ts`) — one sub-agent
- **Skills the user flagged as modified** (or all of them for Tier 3) — one sub-agent per skill, comparing the user's current files against the skill merge commit version:
  ```
  git diff <merge-commit-hash>..HEAD -- <files-touched-by-skill>
  ```
- **Container files** — one sub-agent (if changes exist)

Each sub-agent task:

> Read these diffs and the current file contents. For each change:
> 1. `git diff $BASE..HEAD -- <file>` (or `git diff <skill-merge-hash>..HEAD -- <file>` for skill-modified files)
> 2. Read the full current file for context
> 3. Summarize: what changed, what the likely intent is
> 4. Assess detail level: could a fresh Codex session reproduce this from intent alone, or does it need specific code snippets, API details, import paths?
> 5. For non-standard changes, extract the key code, imports, API calls, and configurations verbatim.

**Inter-skill conflicts:** If multiple skills are applied, spawn an additional sub-agent to check for interactions between them. Look for:
- Duplicate declarations (same variable/constant defined by two skill branches)
- Conflicting approaches (one skill throws on missing env var, another provides a fallback)
- Shared files modified by multiple skills

Document any findings in the "Skill Interactions" section of the migration guide so they can be resolved after skill branches are re-merged during upgrade.

## 1.5 Confirm with user

After sub-agents report back, compile the findings and present to the user.

For customizations where the intent is clear (config values, simple modifications): present as a batch for confirmation. Use AskUserQuestion with multiSelect to let the user flag any entries that need correction.

For customizations where the intent is ambiguous: ask specific questions. Don't ask "what did you do?" — instead ask "I see you added X in this file. Was this for Y or something else?"

The user can select "Other" on any question to provide their own description.

## 1.6 Migration plan (Tier 3 only)

For complex migrations, before writing the guide, create a migration plan:

- **Order of operations**: which customizations depend on others, which skills must be applied first
- **Staging**: whether the migration should happen in stages (e.g. apply skills first, validate, then apply source customizations)
- **Risk areas**: customizations that touch files heavily changed by upstream — these may need manual review
- **Interactions**: customizations that interact with each other (e.g. a source change that depends on a skill, or two customizations that touch the same file)

Present the plan to the user for review before proceeding to the guide.

## 1.7 Write the migration guide

**Storage:** `.nanoclaw-migrations/guide.md` for Tier 2. `.nanoclaw-migrations/` directory with `index.md` and section files for Tier 3.

**Verification:** After writing the guide, read it back and verify:
- Every referenced file path exists in the current codebase
- Code snippets match what's actually in the files
- No customizations from the analysis were accidentally omitted

The guide is structured markdown that a fresh Codex session can follow to reproduce this user's exact setup on a clean upstream checkout.

Structure:

```markdown
# NanoClaw Migration Guide

Generated: <timestamp>
Base: <BASE hash>
HEAD at generation: <HEAD hash>
Upstream: <upstream HEAD hash>

## Migration Plan

(Tier 3 only — big-picture overview of order, staging, risks)

## Applied Skills

List each skill with its branch name. These are reapplied by merging the upstream skill branch.

- `add-telegram` — branch `skill/telegram`
- `add-voice-transcription` — branch `skill/voice-transcription`

Custom skills (user-created, not from upstream): `.Codex/skills/my-custom-skill/` — copy as-is from main tree.

## Skill Interactions

(Document known conflicts or interactions between applied skills.
When two or more skills modify the same file or depend on shared
config, describe the conflict and how to resolve it after merging.
Example: skill A and skill B both add a PROXY_BIND_HOST declaration —
after merging both, deduplicate. Or: skill A throws if ENV_VAR is
missing, but skill B provides a fallback — use the fallback version.)

## Modifications to Applied Skills

### <Skill name>: <what was modified>

**Intent:** ...

**Files:** ...

**How to apply:** (after the skill branch has been merged)

...

## Customizations

### <Descriptive title for customization>

**Intent:** What the user wants and why.

**Files:** Which files to modify.

**How to apply:**

<For standard changes, a brief description is enough.>

<For non-standard changes, include code snippets, API details,
specific values, import paths — everything needed to reproduce
without seeing the original diff.>

### <Next customization...>
```

**Judging detail level:** For each customization, assess whether a fresh Codex session could reproduce it from intent alone:
- **Standard changes** (config values, simple logic, well-known patterns): describe the intent and the target. Example: "Change `POLL_INTERVAL` in `src/config.ts` from 2000 to 1000."
- **Non-standard changes** (specific API usage, custom integrations, unusual patterns, library-specific configurations): include the actual code snippets, import paths, API endpoints, configuration objects — everything needed to reproduce it without guessing.

Example entries at different detail levels:

**Standard (brief):**
```markdown
### Custom trigger word

**Intent:** Use `@Bob` instead of the default `@Andy`.

**Files:** `src/config.ts`

**How to apply:** Change the default value of `ASSISTANT_NAME` from `'Andy'` to `'Bob'`.
```

**Non-standard (detailed):**
```markdown
### Spanish translation for outbound messages

**Intent:** All outbound messages are translated to Spanish before sending. Uses the DeepL API via the `deepl-node` package.

**Files:** `src/router.ts`, `package.json`

**How to apply:**

1. Add dependency: `npm install deepl-node`

2. In `src/router.ts`, add import at top:
   ```typescript
   import * as deepl from 'deepl-node';
   const translator = new deepl.Translator(process.env.DEEPL_API_KEY!);
   ```

3. In the `formatOutbound` function, before the return statement, add:
   ```typescript
   const result = await translator.translateText(text, null, 'es');
   text = result.text;
   ```
   Note: the function needs to be made async if it isn't already.
```

After writing, offer to commit for the user:
```bash
git add .nanoclaw-migrations/
git commit -m "chore: save migration guide"
```

Ask (AskUserQuestion): "Migration guide saved. Want to upgrade now or later?"
- **Upgrade now** — continue to Phase 2
- **Later** — stop here

---

# Phase 2: Upgrade

## 2.0 Preflight

Same checks as 1.0 — clean tree (offer to stash/commit if dirty), upstream configured, fetch latest.

Read the migration guide. If missing, tell the user you need to extract customizations first and ask if they want to do that now.

**New-changes guard:** Compare the guide's "HEAD at generation" hash against current HEAD. If there are commits since the guide was generated, warn the user:

> "You've made changes since the migration guide was generated. These changes won't be included in the upgrade."

AskUserQuestion:
- **Update the guide first** — go to step 1.2 to incorporate new changes
- **Proceed anyway** — user accepts that recent changes will be lost
- **Abort** — stop

## 2.1 Safety net

```bash
HASH=$(git rev-parse --short HEAD)
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
git branch backup/pre-migrate-$HASH-$TIMESTAMP
git tag pre-migrate-$HASH-$TIMESTAMP
```

Save the tag name for rollback instructions at the end.

## 2.2 Preview upstream changes

```bash
BASE=$(git merge-base HEAD upstream/$UPSTREAM_BRANCH)
git log --oneline $BASE..upstream/$UPSTREAM_BRANCH
git diff $BASE..upstream/$UPSTREAM_BRANCH -- CHANGELOG.md
```

If there are `[BREAKING]` entries, show them and explain how they interact with the user's customizations from the migration guide.

Ask (AskUserQuestion) to proceed or abort.

## 2.3 Create upgrade worktree

```bash
PROJECT_ROOT=$(pwd)
git worktree add .upgrade-worktree upstream/$UPSTREAM_BRANCH --detach
WORKTREE="$PROJECT_ROOT/.upgrade-worktree"
```

Store `$PROJECT_ROOT` and `$WORKTREE` as absolute paths. Use `$WORKTREE` in all subsequent commands — never `cd .upgrade-worktree` with a relative path.

## 2.4 Reapply skills in worktree

For each skill listed in the migration guide's "Applied Skills" section:

1. Check if branch exists: `git branch -r --list "upstream/$branch"`
2. If yes, merge it in the worktree:
   ```bash
   cd "$WORKTREE" && git merge upstream/skill/<name> --no-edit
   ```
3. If missing, warn the user (skill may have been removed or renamed upstream).
4. If any skill merge conflicts, stop and tell the user — the skill needs updating for the new upstream.

Copy any custom skills mentioned in the guide from the main tree into the worktree.

## 2.5 Reapply customizations in worktree

Work in `.upgrade-worktree/`. Follow each customization section in the migration guide, including "Modifications to Applied Skills."

For Tier 3 migrations with a migration plan, follow the plan's ordering and staging. If the plan calls for staged validation (e.g. validate after skills, then validate after source changes), do so.

For each customization:
1. Read the "How to apply" instructions from the guide
2. Read the target file(s) in the worktree to understand the current upstream version
3. Apply the changes as described — use the code snippets and specific instructions from the guide
4. If the target file has changed significantly from what the guide expects (function removed, file restructured, API changed), flag it and ask the user what to do
5. Verify the file has no syntax errors or broken imports after each change

For behavior customizations (AGENTS.md files): copy from the main tree. These are user content, not code.

## 2.6 Validate in worktree

```bash
cd "$WORKTREE" && pnpm install && pnpm run build && pnpm test
```

If build fails, show the error. Fix only issues caused by the migration. If unclear, ask the user.

## 2.7 Live test (optional)

Ask (AskUserQuestion):
- **Test live** — stop service, run from worktree against real data, send a test message
- **Skip** — trust the build, proceed to swap

If testing live:

1. Stop the service (do this directly):
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null || true
   ```

2. Symlink data into the worktree:
   ```bash
   ln -s "$PROJECT_ROOT/store" "$WORKTREE/store"
   ln -s "$PROJECT_ROOT/data" "$WORKTREE/data"
   ln -s "$PROJECT_ROOT/groups" "$WORKTREE/groups"
   ln -s "$PROJECT_ROOT/.env" "$WORKTREE/.env"
   ```

3. Start from worktree: `cd "$WORKTREE" && pnpm run dev`

4. Ask the user to send a test message from their phone. Wait for them to confirm it works.

5. After confirmation, stop the dev server.

6. Clean up symlinks:
   ```bash
   rm "$WORKTREE/store" "$WORKTREE/data" "$WORKTREE/groups" "$WORKTREE/.env"
   ```

## 2.8 Swap into main tree

The swap must be done carefully — the worktree has the upgraded code, but main needs to point to it cleanly. Use absolute paths throughout.

```bash
# 1. Capture the worktree HEAD before removing it
WORKTREE_PATH=$(cd "$PROJECT_ROOT/.upgrade-worktree" && pwd)
UPGRADE_COMMIT=$(git -C "$WORKTREE_PATH" rev-parse HEAD)

# 2. Copy the migration guide out of the worktree before removing it
cp -r "$WORKTREE_PATH/.nanoclaw-migrations" /tmp/nanoclaw-migrations-backup 2>/dev/null || true

# 3. Remove the worktree
git worktree remove "$WORKTREE_PATH" --force

# 4. Point the current branch at the upgraded commit
git reset --hard $UPGRADE_COMMIT

# 5. Restore the migration guide and update its hashes
cp -r /tmp/nanoclaw-migrations-backup/* .nanoclaw-migrations/ 2>/dev/null || true
rm -rf /tmp/nanoclaw-migrations-backup
```

Update the guide's header hashes to reflect the new state. Offer to commit:
```bash
git add .nanoclaw-migrations/
git commit -m "chore: upgrade to upstream $(git rev-parse --short upstream/$UPSTREAM_BRANCH)"
```

Do NOT use `git checkout -B` to create an intermediate branch — this caused issues in practice. The `git reset --hard` to the upgrade commit is the cleanest path since the backup tag already preserves the pre-upgrade state.

## 2.9 Post-upgrade

Run `npm install && pnpm run build` in the main tree to confirm.

Restart the service:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

Show summary:
- Previous version (backup tag)
- New HEAD
- Customizations reapplied (list from guide)
- Skills reapplied
- Rollback: `git reset --hard <backup-tag>`
- Any customizations that needed manual adjustment

Offer to pop the stash if one was created in preflight: `git stash pop`

## Diagnostics

1. Use the Read tool to read `.Codex/skills/migrate-nanoclaw/diagnostics.md`.
2. Follow every step in that file before finishing.
