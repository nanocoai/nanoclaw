# Releasing NanoClaw

Starting with v2.0.63, the goal is to publish a GitHub Release for every `package.json` version bump that lands on `main`. A maintainer prepares the release in a pull request, then runs the explicit Release workflow after it merges. The intent is _timeliness_, not strict 1:1 correlation with every bump.

Each release ships:

- A tagged commit on `main` (`vX.Y.Z`).
- A `CHANGELOG.md` entry under `## [<version>] - <YYYY-MM-DD>`.
- A GitHub Release whose body mirrors the CHANGELOG entry plus a contributors section.

## When to cut a release

A release is cut by a maintainer publishing it. The trigger is a release PR that bumps `package.json` and adds its `CHANGELOG.md` entry. There is no fixed schedule, and back-to-back changes may be rolled into one release. Cutting at least weekly is preferable to batching: smaller releases are easier to read, pin, and revert.

## What goes in a release

`CHANGELOG.md` is the canonical record of user-visible change. The release body on GitHub mirrors it. Aim for:

- **A short opening.** One paragraph starting `NanoClaw X.Y.Z adds …` that names what matters for the person running NanoClaw, then the categories below.
- **`### ⚠️ Before you update` first** whenever an entry needs action or changes cost. Every `[BREAKING]` item lives here with its migration inline on the same bullet line: keep the tag at the start of the line (the update controller and `scripts/release.mjs` look for it), say who is affected, the exact command or edit, and how to check success. A link to a longer detect/fix/verify/rollback guide may follow the inline action, never replace it.
- **Then `### ✨ New`, `### 🛠️ Fixes`, `### 🔒 Security`, and `### 🔧 For custom installations`**, in that order, skipping empty ones. One emoji per heading, always with the text label.
- **One outcome per bullet.** A bold lead that states the operator-facing result, then one or two sentences of detail. Fold small related fixes into one bullet rather than adding a plain-bullet tail.
- **Inline commands and repo-relative doc links**, e.g. `[gateway migration](docs/gateway-seam.md#migrating-an-existing-installation)`. Distinguish new installations, existing installations, and customized forks when the action differs.
- **No PR numbers** in the user-facing prose. PR references can live in the GitHub Release's `## Contributors` section.

Keep `## [Unreleased]` and dated `## [X.Y.Z] - YYYY-MM-DD` headings unchanged; categories are level-three headings inside the version section and `scripts/release.mjs extract` carries them into the release body. Published release bodies are immutable; improve the next entry rather than rewriting history. [CHANGELOG.md](CHANGELOG.md) `[2.4.0]` is the reference entry.

## Harvesting release notes from merged pull requests

The v2 pull request template (`<!-- nanoclaw-pr-template:v2 -->`) carries an optional fenced
```release-note``` block: one user-facing line, written by the contributor who knows what changed.
`scripts/release-notes.mjs` collects those blocks across a merge range and prints a draft for you
to edit:

```bash
node scripts/release-notes.mjs draft                      # since the last tag reachable from HEAD
node scripts/release-notes.mjs draft --since v2.3.0        # explicit range start
node scripts/release-notes.mjs draft --until <sha> --json  # machine-readable
```

It reads pull request bodies and labels through `gh api graphql`, so an authenticated `gh` is
required. Harvested notes are grouped by the PR's `kind/*` label — the same managed vocabulary
`.github/workflows/label-pr.yml` applies — and each bullet carries its PR link and author so you can
go back to the source. Pull requests whose block is absent or still holds the template prompt are
listed under **Needs a line** instead of being dropped silently; write a line for the user-visible
ones and ignore the rest. A PR that ticked the breaking-change box keeps its `[BREAKING]` warning
there too, so an unwritten migration cannot disappear from the draft.

The draft is a starting point, not the entry. Curate it into the shape described above, then paste
what you keep under `## [Unreleased]`. The tool prints to stdout and never writes `CHANGELOG.md`.

## Publishing the release

Before any release run, a repository administrator must configure and re-check its external safety controls:

- Create a `release` environment with `gavrielc` and `omri-maya` as its only required reviewers, prevent self-review and administrator bypass, and add a deployment branch policy that permits only `main`. Merely naming a missing environment in a workflow is not protection: GitHub creates it without protection rules on first use.
- Enable immutable releases under **Settings → General → Releases**. This locks the tag and assets after publication and applies only to releases published after the setting is enabled.

Also create an active tag ruleset for `refs/tags/v*` that restricts updates and deletions, with no bypass. It closes the gap between the workflow pushing a tag and publishing the immutable release while still allowing a new tag to be created.

The workflow's `GITHUB_TOKEN` cannot read the immutable-release setting because GitHub's endpoint requires repository Administration-read permission. An administrator must therefore perform this preflight before the maintainer dispatches `verify`:

```bash
gh api -H 'X-GitHub-Api-Version: 2026-03-10' \
  repos/nanocoai/nanoclaw/immutable-releases

gh api repos/nanocoai/nanoclaw/rulesets \
  --jq '.[] | select(.target == "tag" and .enforcement == "active") | {id, name}'
```

The first command must return `{"enabled":true,...}`; a 404 is a hard stop. Use the returned tag-ruleset ID to read its full configuration and confirm that it targets `refs/tags/v*`, restricts updates and deletions, and has no bypass actors. Record the administrator, timestamp, immutable-setting response, and ruleset ID in the release tracker. Do not dispatch based only on a “done” message.

The Release workflow independently checks the protected `release` environment in both `verify` and `publish` modes. Its reviewer roster is an exact authorization boundary, not a minimum: roster changes require a reviewed workflow and runbook update. Dispatching from any ref other than `main` fails before verification starts.

1. Open one release PR that:
   - bumps `package.json` to the exact version being released;
   - moves the curated user-facing notes from `Unreleased` to `## [X.Y.Z] - <YYYY-MM-DD>` in `CHANGELOG.md`;
   - keeps every breaking change's migration path inline;
   - leaves `## [Unreleased]` in place for the next cycle.
2. Merge the release PR only after normal CI passes.
3. After an administrator records the safety-control preflight, copy the full 40-character SHA of the merged release commit. In **Actions → Release**, select `main`, enter that SHA and the exact version without a `v` prefix, choose `verify`, and run the workflow. It checks the protected release environment, release metadata, and the complete host and container CI suite on that exact commit, and makes no repository changes.
4. Read the verification summary. Confirm the target SHA, previous tag, extracted notes, and absence (or safe recovery state) of the new tag and release.
5. Run the same workflow again with the same version, the same full SHA, and `publish`. The publish job re-verifies the immutable inputs, creates an annotated `vX.Y.Z` tag on that exact commit, assembles the curated notes plus contributor sections, and publishes the GitHub Release.
6. Read back the tag target and release body from GitHub. Confirm `package.json`, the tag, the release title, and the changelog all name the same version.

The workflow never commits or pushes to `main`. After creating the Release, it retries the read-back six times with bounded exponential backoff while GitHub propagates either the new Release listing or its immutable state. Exact title, body, tag, and SHA mismatches still fail immediately, and the workflow fails closed after the retry deadline.

If publication fails after the tag push, rerun `publish`: it accepts an existing annotated tag only when that tag resolves to the exact workflow SHA, then resumes release creation. If the release was already published, the rerun succeeds without writing only after the tag target, release tag, title, published state, non-prerelease state, immutable state, and body all exactly match the requested publication. A release that remains mutable never becomes a successful retry; any mismatch fails closed.

## Rollup releases

If multiple `package.json` bumps land between two GitHub Releases (as happened between v2.0.54 and v2.0.63), the next release is a rollup: its CHANGELOG entry covers everything merged since the last released tag, and the body opens with a one-line "Rollup release covering vX.Y.Z through vX.Y.W." note. The recovery release receives a fresh version so its package bump and changelog entry can still be reviewed together. After catch-up, return to one release per bump.

## Channels and stability

NanoClaw currently ships a single channel: every published release is a stable release.

- **Latest** — the most recent release on `main`, shown as "Latest release" on the GitHub Releases page. Consumers that want auto-bump follow GitHub's `/releases/latest` pointer.
- **Stable** — currently identical to latest. NanoClaw has no separate stable branch and no pre-release/RC channel.
- **Pinned** — any tagged release. Reproducible and the recommended choice for packagers and forks; published tags are not moved or retracted.

If a pre-release channel is introduced later (e.g. `vX.Y.Z-rc.N`), those releases will be marked "Pre-release" on GitHub so they do not become the `latest` pointer, and this section will be updated to describe the promotion path.

The tag is the source of truth — a GitHub Release's `target_commitish` always points to a tagged commit.
