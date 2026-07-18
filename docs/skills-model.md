# The skills model

How NanoClaw stays customizable without breaking its forks. This is the full version; [customizing.md](customizing.md) is the short one, and [skill-guidelines.md](skill-guidelines.md) is the authoritative checklist for writing a skill.

## The problem

People fork NanoClaw and change the code. When we ship updates, their changes collide with ours and `git merge` turns into a fight. The more someone customized, the worse it gets. We can't grow the core without breaking everyone downstream.

## The bet

Every customization is a skill: not an edit buried in the core, but a skill that adds the change on top.

The core stays small and stable. Everything else composes on top as skills. Adding your 1st skill and your 500th skill is the same amount of work.

This works for any fork: a personal install with three tweaks, a company build with fifty.

## A fork is a recipe of skills

You don't track your changes as a pile of edits. You track them as skills.

- Each customization = one small skill.
- One "recipe" skill lists all your skills and how they fit together: the order, and any dependencies between them.

So a fork is defined by its recipe. Most upgrades don't need to run it (see "Upgrading"), but it's what lets you rebuild the fork from scratch on clean upstream, and it's how you hand your whole fork to someone else. It replaces every "what did I change" artifact you'd otherwise keep (a migration guide, a manifest, a pile of notes) with one runnable thing.

The recipe is the one fork-specific thing. It lives in your fork, never upstream. (A recipe is itself a skill: a SKILL.md listing the fork's skills in apply order.)

## What's in a skill

A skill carries everything it needs:

- **Its code**: the files it adds (see "Where a skill's files live").
- **Apply and remove.** Apply installs it; remove uninstalls it. Uninstall isn't a separate problem; it ships with the skill. (Remove is required exactly when apply leaves anything behind. A pure instruction-only skill that changes nothing needs none.)
- **Its tests**: see "A test for every integration point." The tests *are* the verification. If they pass against the composed project, the skill applied correctly and works; there is no separate "verify" step.
- **Its recipe entry**: how it composes with the others.

Apply must be safe to re-run. Upgrades re-run skills, so a skill that half-applies twice is a bug.

**Two readers, one document.** The trunk channel and provider installs that the setup wizard drives are written so the wizard can apply the same SKILL.md a coding agent would follow — anything the wizard can't do mechanically falls back to the agent. This is core tooling, not part of the model's contract: a plain-prose skill is a first-class skill. (Details: [skill-directives.md](skill-directives.md).)

## Two kinds of skills

- **Capability skills** add something new: a channel, a provider, a tool, a dashboard.
- **Patch skills** make small tweaks or bug fixes to existing behavior, instead of adding a capability.

Patch skills follow the same rules: a test for every edit, and code pushed into independent files wherever possible instead of inline. To keep the overhead down, bundle several small patches into a single patch skill rather than making one skill per one-line fix.

One honest exception: a bug fix that genuinely changes an existing line can't always be moved into a new file. That single line is the one place an upgrade can still hard-conflict. If upstream touched the same line, the fix has to be re-derived against the new code. That's fine when it's small and tested; just don't pretend it's free.

(Packaging is a separate axis: some skills fetch code from a registry branch, some ship files in their own folder, some are pure instructions.)

## What makes a good skill

A good skill mostly just *adds* things:

- Adds new files.
- Adds a line to an existing file (an import, an entry, a line in `.env`).
- Adds a dependency.
- Changes a value in a JSON file like `package.json`.

These never really break.

The one risky move is when a skill has to *reach into* existing code and wire something in at a specific spot. That's the only part that breaks when we change the code later. Keep these rare, and keep them to a line or two that just *calls* code living in the skill's own files, not big chunks of logic inline.

Rule of thumb: aim for skills that are almost all "adds." Not 100%; some reach-ins are fine. But a skill full of reach-ins is a smell, and a sign that spot in the core should become a proper hook.

## Where a skill's files live

The files a skill adds live in the skill's own folder, and the skill copies them into the project when it runs. The skill is self-contained.

The exception is skills that plug into a registry: channels and providers. Their code is larger, multi-file, and has to stay in sync with the core as it changes over time. That code lives on a long-lived **registry branch** (`channels`, `providers`) that we forward-merge against main, and the skill fetches it from there (`git show origin/channels:path > path`). A frozen copy in a skill folder would go stale.

This fetch is **additive, never a merge**. The skill copies in the files it needs; it does *not* `git merge` the branch. Merging a registry branch into a customized install is exactly the conflict fight this model exists to avoid. A skill's **tests live on the branch alongside its code** and are fetched the same way; a channel's adapter travels with its registration test. A provider is the multi-point case: its code spans the host *and* container trees plus a Dockerfile edit, so it fetches files into both trees and ships a registration test per tree. See the provider archetype in [skill-guidelines.md](skill-guidelines.md).

Either way the skill brings its own code, from its folder or from its branch.

## A test for every integration point

The tests a skill *must* ship are the ones that prove it integrates with the core and keeps working as the core changes. That's the whole point. Tests of a skill's own internal logic, or of its behavior against an external service, are fine but optional: the creator's call, because they don't guard against upstream changes. A pure-add skill that touches nothing existing needs no required integration test at all.

The places that break on upgrade are the **integration points**: wherever a skill reaches into the existing system. That's not just the obvious code edit. An appended import, a config entry, a Dockerfile change, a mount, an installed dependency, and a direct read of the core's data all count. Each gets a guard that goes **red if it breaks or goes missing**:

- **A behavior or structural test of the wiring.** Prefer behavior when the seam is queryable at runtime: a channel's registration test imports the real barrel and asserts the registry contains it. Fall back to a structural test only for wiring with no invocable seam.
- **The build / typecheck.** Always on. It catches the drift a runtime test can't: a renamed symbol, a moved module, a changed signature.
- **Coverage of how an added file consumes the core.** When a skill's own file reaches into core APIs or data, a test must exercise that consumption against the *real* core. That's the leg that catches core drift.

Why points and not whole skills: a skill can have several, and each is a separate way to break. The count is honest signal: a skill's integration points are exactly its upgrade risk. Pure-add skills have zero and stay cheap.

This is what makes upgrades cheap to fix: when we move something in the core, the integration-point tests are exactly what fail, and that failing list *is* the set of skills to update.

**Tests travel with the skill.** They're files kept with the skill, in its folder or on its branch, and applying the skill copies them into the project's test tree. An integration-point test has to run against the *composed* system, so it only means anything once the skill is applied.

**The recipe tests the stack.** A single skill's tests prove that skill works alone. The recipe carries tests that run the skills *together*, in order. That's where you catch two skills that collide.

The full testing doctrine (how to pick the test type per point, the archetypes, the dependency cases) is in [skill-guidelines.md](skill-guidelines.md).

## How you actually work

You don't have to write a skill before you touch anything. Edit the code directly, get it working, then turn those edits into skills afterward; a coding agent does that conversion. Good authoring guidelines and a good recipe make skillifying-after-the-fact close to trivial.

The point isn't to slow you down at edit time. It's that nothing counts as part of your fork until it's a skill, because that's the only form that survives an upgrade.

## Upgrading

**Every update goes through `/update-nanoclaw`, never a raw `git pull`.** You don't know what an update contains until it lands; it might carry a breaking change with a migration. So the command inspects what's coming and runs the proper process: back up, pull the changes in, apply migrations, run tests, fix what broke, and flag when a fresh rebuild is needed instead.

Two different moves, two different rules. Your **fork pulls trunk**: that's a normal pull, run by the update command, and it's safe precisely because your changes live beside the core as skills rather than inside it. A **skill never merges**: it installs by fetching files and copying them in. If a skill's instructions say `git merge`, it isn't built to this model.

The update takes one of two paths:

**Normal upgrade: pull and fix what breaks.** Most of the time it pulls the latest upstream, resolves the occasional small conflict, runs the tests, and fixes whatever they flag. This stays cheap *because* the changes are small self-contained skills with tests: conflicts are rare, and when something does break, the failing test points at the exact skill and the fix is local.

**Rebuild from the recipe: the rare path.** Take fresh upstream and apply every skill from scratch. The command flags this when you've fallen far behind across many breaking changes (a clean rebuild beats catching up step by step). It's also how you hand your entire fork to someone else.

Around both:

- **The update skill updates itself first.** The first thing it does is fetch the latest version of the upgrade process. Otherwise you're upgrading with stale instructions.
- **Snapshot first, restore on failure.** The upgrade sets a rollback point before it starts: today a git backup branch and tag; the model calls for a full project snapshot (code, database, data, files) so anything that fails rolls back and retries. Until that snapshot lands, a migration that touches data makes its own data backup. Nothing in the upgrade needs its own undo logic.
- **Broken skills don't block you.** If a core change broke a skill, its test tells you, but the skill is usually still usable, and an agent fixes it at apply time. Skills are fixed lazily, when applied, not ahead of time for every core version.

## Migrations

Migrations are core, not an afterthought. Every breaking change ships with its migration, packaged together. A "migration" is broad: upgrading dependencies, a database change, a data backfill, moving files to new locations, whatever the change requires.

Migrations are **forward-only**. They don't need reverse scripts; the rollback point in front of the upgrade is the undo. If one fails, restore and retry.

A **startup tripwire** keeps installs on the supported path. Every sanctioned update path (install, update, migrate) stamps a marker with the version it reached; at startup the host checks that marker against the running code. If it's missing or doesn't match, because someone pulled by hand, the host stops, loudly, with the exact command to fix it instead of silently breaking.

The tripwire doesn't reason about *which* changes are breaking; it just enforces that the path was used. (DB schema migrations already run automatically at startup, so they aren't its concern; it guards everything else a raw `git pull` leaves undone.) To override, you stamp the marker yourself: an explicit "I know what I'm doing," not a deletion. If you have your **own** upgrade flow (a deploy script, a CI job), make stamping the last step after it succeeds: `pnpm exec tsx scripts/upgrade-state.ts set`. See [upgrade-recovery.md](upgrade-recovery.md).

## The maintainer's side of the deal

This is a two-sided contract. Users keep their changes as skills. In return, the maintainer keeps the core stable and owns the breakage.

As maintainer:

1. **Keep the core small and stable.** Resist hardwiring features into the core. Push them to skills too.
2. **Before shipping a core change, run the skills against it.** That tells you what you broke before users find out.
3. **When you break a skill, you fix it, not the users.** If a refactor moves something, update the affected skills or ship a migration. Don't make every user rediscover the same fix.
4. **Ship the migration with the breaking change.** Packaged together: code, DB, files. Not a separate "good luck" note.
5. **Watch for hotspots.** When lots of skills reach into the same spot in the core, that's the signal to add a proper hook there, so those reach-ins become clean adds.
6. **Test against real forks.** Every core change and migration runs against a fleet of real, skill-built forks before shipping. Real proof on real installs.

## The public registry

Skills will be shared and composed; that's the whole point. A skill runs real code when it applies (copies files, installs dependencies, edits the Dockerfile). So a public registry of skills is a trust surface.

The rule: **every skill is reviewed and approved before it goes into the public registry, and every new version is re-reviewed.** Approving once and trusting forever is how supply chains get poisoned. Automated checks (linting against the guidelines, plus a harness that applies the skill on fresh upstream, runs its tests, removes it, and applies it twice) will clear the mechanical part so human review can focus on intent and safety. First-party skills are trusted by where they come from; the gate is for the public registry.

## The promise

Build your changes as skills following this, and we won't break you. It's a promise we can only make for skills: changes edited directly into the core are beyond what we can protect.
