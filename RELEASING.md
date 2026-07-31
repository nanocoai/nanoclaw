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

- **Bold lead-ins** per major feature or fix, then a sentence-case prose explanation.
- **`[BREAKING]` prefix** for any change that requires user action. Always include the workaround inline — never link to a separate doc for the fix.
- **Doc links** for major features (relative paths into the repo, e.g. `[setup/lib/install-slug.sh](setup/lib/install-slug.sh)`).
- **Inline commands** for actionable steps, in backticks.
- **Minor items** as single plain bullets at the bottom of the entry, no bold lead-in.
- **No PR numbers** in the user-facing prose. PR references can live in the GitHub Release's `## Contributors` section.

## Publishing the release

Before this workflow lands, a repository administrator must configure its two external safety controls:

- Create a `release` environment with `gavrielc` and `omri-maya` as its only required reviewers, prevent self-review and administrator bypass, and add a deployment branch policy that permits only `main`. Merely naming a missing environment in a workflow is not protection: GitHub creates it without protection rules on first use.
- Enable immutable releases under **Settings → General → Releases**. This locks the tag and assets after publication and applies only to releases published after the setting is enabled.

Also create an active tag ruleset for `refs/tags/v*` that restricts updates and deletions, with no bypass. It closes the gap between the workflow pushing a tag and publishing the immutable release while still allowing a new tag to be created.

1. Open one release PR that:
   - bumps `package.json` to the exact version being released;
   - moves the curated user-facing notes from `Unreleased` to `## [X.Y.Z] - <YYYY-MM-DD>` in `CHANGELOG.md`;
   - keeps every breaking change's migration path inline;
   - leaves `## [Unreleased]` in place for the next cycle.
2. Merge the release PR only after normal CI passes.
3. Copy the full 40-character SHA of the merged release commit. In **Actions → Release**, select `main`, enter that SHA and the exact version without a `v` prefix, choose `verify`, and run the workflow. It checks release metadata, runs the complete host and container CI suite on that exact commit, and makes no repository changes.
4. Read the verification summary. Confirm the target SHA, previous tag, extracted notes, and absence (or safe recovery state) of the new tag and release.
5. Run the same workflow again with the same version, the same full SHA, and `publish`. The publish job re-verifies the immutable inputs, creates an annotated `vX.Y.Z` tag on that exact commit, assembles the curated notes plus contributor sections, and publishes the GitHub Release.
6. Read back the tag target and release body from GitHub. Confirm `package.json`, the tag, the release title, and the changelog all name the same version.

The workflow never commits or pushes to `main`. If publication fails after the tag push, rerun `publish`: it accepts an existing annotated tag only when that tag resolves to the exact workflow SHA, then resumes release creation. If the release was already published, the rerun succeeds without writing only after the tag target, release tag, title, published state, non-prerelease state, and body all exactly match the requested publication. Any mismatch fails closed.

## Rollup releases

If multiple `package.json` bumps land between two GitHub Releases (as happened between v2.0.54 and v2.0.63), the next release is a rollup: its CHANGELOG entry covers everything merged since the last released tag, and the body opens with a one-line "Rollup release covering vX.Y.Z through vX.Y.W." note. The recovery release receives a fresh version so its package bump and changelog entry can still be reviewed together. After catch-up, return to one release per bump.

## Channels and stability

NanoClaw currently ships a single channel: every published release is a stable release.

- **Latest** — the most recent release on `main`, shown as "Latest release" on the GitHub Releases page. Consumers that want auto-bump follow GitHub's `/releases/latest` pointer.
- **Stable** — currently identical to latest. NanoClaw has no separate stable branch and no pre-release/RC channel.
- **Pinned** — any tagged release. Reproducible and the recommended choice for packagers and forks; published tags are not moved or retracted.

If a pre-release channel is introduced later (e.g. `vX.Y.Z-rc.N`), those releases will be marked "Pre-release" on GitHub so they do not become the `latest` pointer, and this section will be updated to describe the promotion path.

The tag is the source of truth — a GitHub Release's `target_commitish` always points to a tagged commit.
