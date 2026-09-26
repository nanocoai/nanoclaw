# Customizing NanoClaw

NanoClaw is made to be forked and changed. The catch with most projects is that once you edit the code, every upstream update turns into a merge fight, and the more you customized, the worse it gets.

NanoClaw avoids that with one simple idea: **every change you make is a skill.**

## The idea in a minute

- A **skill** is a small, self-contained add-on. It brings its own code and knows how to install itself.
- Your **fork is just a list of skills**, plus one "recipe" that says which skills you have and how they fit together.
- Because your changes live beside the core instead of tangled into it, **pulling in updates stays easy**.

## What makes it work

A good skill mostly **adds** things: new files, a line appended to an existing file, a dependency. It avoids rewriting existing code in place.

And it ships a test for each spot where it touches the rest of the system. When an update moves something your skill depends on, that test fails and points at the fix, instead of you finding out when things break in production.

## How you actually work

You don't have to think in skills while you're building. **Edit the code directly, get it working, then turn your changes into skills afterward.** A coding agent does the conversion for you, following [skill-guidelines.md](skill-guidelines.md).

The only rule worth remembering: **a change isn't really part of your fork until it's a skill**, because that's the form that survives an upgrade.

## Keep fork-only code in one folder

Until a change becomes a skill (and for code a skill copies in), where it lives decides what an upgrade costs. A merge conflict needs both sides to touch the same file. A file only your fork has can never conflict; every line you add inside an upstream file can, on every future update.

Measured on one real fork upgrade across ~420 upstream commits:

| Fork change                           | Files | Conflicted files    |
| ------------------------------------- | ----- | ------------------- |
| New files that exist only in the fork | 124   | **0**               |
| Edits inside upstream files           | 208   | **91** (~200 hunks) |

Same amount of fork code on both rows. The only difference is where it lived. The convention that follows from it:

1. **One folder, mirroring upstream.** Put every fork-only file under `src/local/` and `container/agent-runner/src/local/` (any name upstream doesn't use), laid out like the upstream tree: `local/modules/`, `local/channels/`, `local/mcp-tools/`, `local/db/`. An upgrade then starts with "keep both `local/` folders" rather than sorting through the tree to find what's yours.
2. **Wire in through an existing registry, one line per upstream file.** A fork feature enters the core by appending a single import to the barrel that owns its kind (`src/modules/index.ts`, `src/channels/index.ts`, `container/agent-runner/src/mcp-tools/index.ts`, the provider barrels). Each of those lines gets a registration test that imports the real barrel and asserts the registry holds your entry, so an upgrade that drops or moves the line fails a test instead of silently disabling the feature. See [skill-guidelines.md](skill-guidelines.md) for the test archetypes.
3. **Extend by wrapping, not editing.** To add behavior around an upstream implementation (retry, fallback, logging, a policy check), write a decorator in `local/` that implements the same interface and delegates to the upstream one, and register the decorator. The upstream file stays untouched.
4. **Never copy upstream helpers.** Import them. A copy goes stale the day upstream changes the original, and nothing tells you.
5. **Need to change an upstream decision? Propose a seam.** When a fork feature needs upstream code to decide something differently, don't edit the decision in place. Contribute a behavior-neutral seam upstream instead (a registry, a strategy with a default, a hook) whose default reproduces today's behavior exactly, with a test proving a registered override is used. Your fork then plugs its policy in from `local/`. Until the seam lands, keep the in-place edit as small as possible and list it somewhere your next upgrade will look.

Skill-owned files are the exception: files a `/add-*` skill fetches to canonical paths (a channel adapter in `src/channels/`, a provider in `src/providers/`) stay where the skill puts them, so re-running the skill keeps working. Migrations stay in `src/db/migrations/`, which their registry owns.

## Upgrading

Always upgrade by running `/update-nanoclaw`. **Don't just `git pull`.** The
command stages upstream in an isolated worktree, refreshes installed skills,
runs the test gates, snapshots mutable state, and health-checks the cutover. Its
rollback restores SQLite and local configuration as well as Git.

## The deal

We keep the core small and stable, and every breaking change ships with its migration. You keep your changes as skills, with tests. Do that, and upgrades won't break you. Changes edited directly into the core are the one thing the model can't protect.

## Go deeper

- **[The skills model in full](skills-model.md)**: how skills, recipes, tests, and upgrades work under the hood.
- **[Skill guidelines](skill-guidelines.md)**: the authoritative checklist for writing one.
