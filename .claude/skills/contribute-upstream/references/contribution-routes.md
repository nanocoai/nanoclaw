# Contribution routes, worktree, and PR flow

## Routes (from upstream CONTRIBUTING.md)

Upstream accepts source changes only for bug fixes, security fixes, simplifications, and
reduced code. Features and capabilities must ship as skills. Every feature gets exactly one route:

| Route | What goes upstream | PR kind | Local code afterwards |
|-------|--------------------|---------|-----------------------|
| `bugfix` | the fix, with a test | `kind/bug` | local patch deleted |
| `seam` | interface + default reproducing current behavior + registration test | `kind/cleanup` | override registers into the seam; upstream-file edits drop to one line |
| `skill` | a `/add-<name>` or utility skill: SKILL.md, code, tests, REMOVE.md | `kind/feature` + `delivery/skill` | local copy replaced by the skill install, local policy stays in the local folder |
| `docs` | docs correction | `kind/documentation` | none |
| `local-only` | nothing | — | stays local |

A feature that needs both a seam and a skill is **two PRs**, seam first. One thing per PR.

Mark `local-only` without asking when any of these hold:

- It exists only to integrate internal systems of your employer or organization (internal
  monitoring, internal MCP servers, internal gateways, internal ticketing). That code and its
  configuration are never contributed, scrubbed or not.
- It is policy, not mechanism (which models, which chats, which thresholds). Only the mechanism
  can be generic.
- It is a skill-owned file (the inventory lists those separately). Changes there go to the skill's
  own registry branch as a normal skill PR, not as a "local feature".

## Before building: search for existing work

```bash
gh pr list --repo nanocoai/nanoclaw --state all --search "<keywords>"
gh issue list --repo nanocoai/nanoclaw --state all --search "<keywords>"
```

If related work exists, record the link in the ledger and build on it instead of duplicating.

## Worktree per approved feature

Every approved feature is built in its own worktree off clean upstream. Nothing local leaks in,
because the branch starts from `upstream/main`, not from this fork.

```bash
git fetch upstream --prune
slug=<feature-slug>
git worktree add "../nanoclaw-contrib/$slug" -b "contrib/$slug" upstream/main
cd "../nanoclaw-contrib/$slug"
pnpm install --frozen-lockfile
```

**Dependency stacking.** When the feature builds on another contribution that has not merged yet,
branch from that feature's branch instead: `git worktree add "../nanoclaw-contrib/$slug" -b
"contrib/$slug" "contrib/<dep>"`. The PR then contains both changes; write "Depends on #<n>" in
Related work, and rebase onto `upstream/main` once the dependency merges.

Rules inside the worktree:

- Write the generic version from scratch against upstream code. Do not copy local files wholesale.
  Port only the mechanism. Rename anything carrying this install's names (the local folder, the
  fork's name, personal handles) to neutral names.
- Never copy `.nanoclaw-contrib/`, `groups/`, private templates, `.env*`, or the denylist.
- Run upstream's full verification: `pnpm run typecheck`, `pnpm run lint`,
  `pnpm run format:check`, `pnpm test`, and the container leg if `container/agent-runner/src/`
  changed (`pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`,
  `cd container/agent-runner && bun test`).
- Commit with a conventional-commit title (`refactor:` for a seam, `fix:`, `feat:` for a skill).
  No co-author trailers.

## Scrub gate (blocking)

From inside the worktree, run the scrub check over the whole branch and the PR body draft:

```bash
pnpm exec tsx <main-checkout>/.claude/skills/contribute-upstream/scripts/scrub-check.ts \
  --denylist <main-checkout>/.nanoclaw-contrib/scrub-denylist.txt \
  --allow-identity "$(git config user.email)" --diff upstream/main ../<slug>.pr-body.md
```

Exit code must be 0. On findings: fix the text, amend, re-run. Never suppress a finding by
editing the denylist to hide it. Then read the full diff yourself once more for anything the
patterns cannot see (business context, customer names, internal product names, screenshots).

## PR hygiene

Show both outputs from the worktree before asking Gate 2:

```bash
git diff upstream/main --stat HEAD
git log upstream/main..HEAD --oneline
```

## Identity: everything goes out as the fork owner's personal identity

Every commit, push, PR and issue is authored by the fork owner's personal accounts, never a work
account. Before the first commit, check `git config user.email` in the worktree is the personal
address (set it with `git config user.email <personal-email>` inside the worktree when the global
default is a work address). Pass that address to the scrub check with `--allow-identity`; every
other commit author or committer is scanned against the denylist, so a work email in any commit
blocks Gate 2. Fix with `git commit --amend --reset-author` (after the operator approves the
rewrite), never push it.

`gh` can hold several accounts with one active at a time. Don't check it on every call: only when a
push or `gh pr create` fails, or the PR shows the wrong author, run `gh auth switch --user
<fork-owner>` and retry.

## Contribution remote (once per install)

PRs need a head branch on a public GitHub fork of `nanocoai/nanoclaw`. If the install's `origin` is
already such a fork, use it as the contribution remote. If `origin` is private or not a GitHub fork,
create a dedicated public fork that holds nothing but contribution branches:

```bash
owner=$(gh api user --jq .login)
gh repo fork nanocoai/nanoclaw --fork-name nanoclaw-contrib --clone=false
git remote add contrib "https://github.com/$owner/nanoclaw-contrib.git"
```

The remote name defaults to `contrib`; use another if the operator prefers. Never push
contribution branches to a private `origin`, and never push to `upstream`.

## Push and PR (only after Gate 2 approval)

```bash
git push -u contrib "contrib/$slug"
gh pr create --repo nanocoai/nanoclaw --head "$owner:contrib/$slug" --base main \
  --title "<conventional title>" --body-file ../<slug>.pr-body.md
```

- The PR body = `.github/PULL_REQUEST_TEMPLATE.md` filled in, following CONTRIBUTING's PR body
  shape: one-sentence purpose, bold-led bullets, the five fixed sections, validation receipts,
  AI-assistance box checked when it applies, and the human-review attestation left for the operator
  to confirm. Keep the file outside the worktree so it is never committed.
- Write the PR URL and `pr-open` into the ledger row's status cell right after creation. A feature
  that ships as several PRs lists every URL in the same cell; `status` reports each one.
