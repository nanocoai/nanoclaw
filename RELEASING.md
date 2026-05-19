# Releasing NanoClaw

Starting with v2.0.63, the goal is to publish a GitHub Release for every `package.json` version bump that lands on `main`. Releases are cut manually by a maintainer, so there can be lag between a bump merging and its release being published. The intent is *timeliness*, not strict 1:1 correlation with every bump.

Each release ships:

- A tagged commit on `main` (`vX.Y.Z`).
- A `CHANGELOG.md` entry under `## [<version>] - <YYYY-MM-DD>`.
- A GitHub Release whose body mirrors the CHANGELOG entry plus a contributors section.

## When to cut a release

A release is cut by a maintainer publishing it. The trigger is a `package.json` bump on `main`, but the publish step is manual — there is no fixed schedule, and bumps that land back-to-back may be rolled into a single release (as v2.0.55 through v2.0.63 were). Cutting more frequently is preferable to batching: smaller releases are easier to read, pin, and revert.

## What goes in a release

`CHANGELOG.md` is the canonical record of user-visible change. The release body on GitHub mirrors it. Aim for:

- **Bold lead-ins** per major feature or fix, then a sentence-case prose explanation.
- **`[BREAKING]` prefix** for any change that requires user action. Always include the workaround inline — never link to a separate doc for the fix.
- **Doc links** for major features (relative paths into the repo, e.g. `[setup/lib/install-slug.sh](setup/lib/install-slug.sh)`).
- **Inline commands** for actionable steps, in backticks.
- **Minor items** as single plain bullets at the bottom of the entry, no bold lead-in.
- **No PR numbers** in the user-facing prose. PR references can live in the GitHub Release's `## Contributors` section.

## Publishing the release

1. Bump `package.json` and add a `CHANGELOG.md` entry in the same commit (commit message: `chore: bump version to vX.Y.Z`).
2. Once the bump commit lands on `main`, open a draft GitHub Release:
   - **Tag:** `vX.Y.Z`, target `main`.
   - **Title:** `vX.Y.Z` (bare version — descriptive content lives in the body, matching the CHANGELOG header pattern).
   - **Body:** copy the CHANGELOG entry verbatim. Append a `## Contributors` section listing every PR author who landed work in the release window. Append a `**Full Changelog**: https://github.com/nanocoai/nanoclaw/compare/<prev-tag>...vX.Y.Z` line at the bottom.
3. If anyone in the window opened their first NanoClaw PR, add a `## New Contributors` section above `## Contributors`, with each first-timer's first PR link and an invite to Discord.
4. Publish (not just save draft).

## Rollup releases

If multiple `package.json` bumps land between two GitHub Releases (as happened between v2.0.54 and v2.0.63), the next release is a rollup: its CHANGELOG entry covers everything merged since the last released tag, and the body opens with a one-line "Rollup release covering vX.Y.Z through vX.Y.W." note. After the catchup, return to one release per bump.

## Channels and stability

NanoClaw currently ships a single channel: every published release is a stable release.

- **Latest** — the most recent release on `main`, shown as "Latest release" on the GitHub Releases page. Consumers that want auto-bump follow GitHub's `/releases/latest` pointer.
- **Stable** — currently identical to latest. NanoClaw has no separate stable branch and no pre-release/RC channel.
- **Pinned** — any tagged release. Reproducible and the recommended choice for packagers and forks; published tags are not moved or retracted.

If a pre-release channel is introduced later (e.g. `vX.Y.Z-rc.N`), those releases will be marked "Pre-release" on GitHub so they do not become the `latest` pointer, and this section will be updated to describe the promotion path.

The tag is the source of truth — a GitHub Release's `target_commitish` always points to a tagged commit.
