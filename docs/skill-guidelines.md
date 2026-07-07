# Skill guidelines

The authoritative checklist for writing a NanoClaw skill: the bar that conformance tooling and registry review will hold every skill to. [customizing.md](customizing.md) is the short introduction; [skills-model.md](skills-model.md) explains why the model works this way. This document evolves with the system; when a rule here proves wrong, fix the rule.

---

## Principles

Every customization is an additive **skill**: not an edit buried in core, but a skill that carries its own code and knows how to install and remove itself. Two principles make a skill *maintainable*; everything else in this document follows from them.

### 1. Minimal integration surface

A skill adds files and makes the **smallest possible reach-ins** into existing code. Adding a file or a dependency never breaks on upgrade; reaching into existing code is the only thing that does, so the integration surface *is* the upgrade risk. Keep reach-ins few, tiny, and ideally a single line that *calls* into the skill's own code.

Follows from this:

- **Mostly add.** See the change shapes below, in safety order.
- **Push logic into skill-owned files** so the core edit is one call, not an inlined block. This shrinks the surface *and* makes the point testable.
- **Colocated, self-contained** edits over edits in two places.
- **Use an existing registry or hook when there is one**: appending to a registry is a smaller surface than reaching into code. When none exists, a true code-level edit is fine and first-class. (Whether to *add* a hook because a spot has become a hotspot is the maintainer's call, not the skill's.)

### 2. A test for every functional integration point

Every reach-in with a **functional consequence** gets a test that goes **red if the wiring is deleted or drifts**. That's what protects the fork from upstream changes. The tests are also the verification: there is no separate "verify" step.

Follows from this:

- **Tests target integration with core, not internal correctness.** Unit tests of a skill's own logic, or its behavior against an external service, are the creator's call: fine, just not required.
- **A direct unit test doesn't count**: calling the skill's own function bypasses the wiring and stays green when the reach-in is deleted. Drive the real entry, or assert the wiring structurally.
- **Build / typecheck is an always-on leg**: drift (moved imports, renamed fields) is the main enemy and slips past runtime tests.
- **The test lives where the point runs**: host code uses vitest under `src/`; container code uses `bun:test` under `container/agent-runner/`.
- **"Functional" is the filter**: weigh a reach-in by what breaks if it's gone. A cosmetic one (raising a log line's level) gets no test.

The two interlock: a minimal surface keeps the integration points few and testable; a test per point keeps the surface safe. *Maintainable = small surface, every functional point guarded.*

---

## Skill anatomy

A skill carries everything it needs:

- **Code**: the files it adds. They live in the skill's own folder, or, for large registry-backed skills like channels and providers, on a registry branch the skill fetches from. Apply copies them in.
- **Apply**: the steps in `SKILL.md`, written as prose an agent can run. Apply must be safe to re-run: upgrades re-run it, and a skill that half-applies twice is a bug.
- **Remove**: a separate `REMOVE.md` that reverses *every* change apply made: barrel lines deleted (not commented out), every copied file removed including tests, dependencies uninstalled, Dockerfile edits reverted, env lines removed. **REMOVE.md is required exactly when apply leaves anything behind.** A pure instruction-only skill that copies nothing needs none, and an empty one is noise.
- **Tests**: files that ship with the skill and are copied into the project's test tree on apply, so they run against the *composed* system.
- **Recipe entry**: how it composes with the fork's other skills (ordering, dependencies).

---

## Change shapes

In rough order of safety:

- **Add a file**: safest. New code in the skill's own files, or fetched from a registry branch (`git show origin/<branch>:path > path`).
- **Append to a file**: an import in a barrel, a line in `.env`, an entry at the end of a list.
- **Edit a value in JSON**: e.g. a `package.json` field.
- **Add a dependency**, pinned to an exact version.
- **Insert into existing code (an "integration point")**: the one risky move. Keep it to a line or two that *calls* code living in the skill's own files, never an inlined block of logic. A skill full of these is a smell.

Fetching from a registry branch is **additive, never a merge**. `git fetch origin <branch>` then `git show origin/<branch>:path > path` per file. Never `git merge` a registry branch into an install.

---

## Integration points

The integration point is wherever the skill reaches into existing code. Make it **minimal, colocated, and self-contained**:

- All real logic lives in the skill's own file behind a single entry function; the edit to core is just the call.
- **Prefer one colocated block** over edits in two places. For an inserted call, a dynamic import at the call site keeps the import and call together and avoids touching the top-of-file import block (itself a merge hotspot):

  ```typescript
  const { startDashboard } = await import('./dashboard-pusher.js');
  await startDashboard();
  ```

  A static import + call is acceptable too; this is a recommendation, not a mandate.
- Keep any gating (feature flags, env checks) *inside* the skill's function, so the core edit stays a single call.
- When the reach-in lands inside an entangled function, extract a tiny skill-owned helper so the core touch is one line, like `args.push(...mySkillEnvArgs())`, rather than exporting the whole function or inlining the logic.

---

## Testing

**What the standard requires: integration with the NanoClaw system.**

- **Required:** a test for every functional integration point, and, where an added file consumes core (core APIs, data shapes, registries), a test that exercises that consumption against the real core. That's the leg that catches core drift.
- **Optional, the creator's call:** unit tests of the skill's own internal logic, or its behavior against an external service. Often good practice; not what defines a maintainable skill, because they don't protect against upstream changes.

### Choosing the test type

For a code-edit integration point, how you test the wiring depends on whether you can invoke the function the edit lives in. **Prefer behavior; fall back to structure.**

- **If the edit lives in an invocable function, test that function's behavior.** Calling it exercises the edit; remove or break the edit and the test goes red. This is the strongest option, and usually available, because a minimal integration point pushes the logic into the skill's own exported function anyway.
- **If the edit lives in a non-invocable entry point** (e.g. `main()` or boot), **use a structural / AST test.** Use the TypeScript compiler API and assert not just that the symbol exists but its **placement**: awaited, a direct statement of the right function, importing the right module path, correctly ordered. A present-but-misplaced call must go red.

Two more legs apply when relevant:

- **Build / typecheck** always applies: it catches a renamed symbol, a moved module, a bad signature.
- **A behavior test of how added code consumes core**, required when the added file reaches into core APIs or data at runtime. When the consumption is a *typed* call into a core API (a Chat SDK adapter calling `createChatSdkBridge`), the build leg already guards it and no separate behavior test is required. The behavior-test requirement targets runtime consumption: core DB state, data shapes, registries.

Together these cover deletion, misplacement, drift, and core consumption. Only true runtime-reachability (a call stranded behind a dead branch) needs the heavy option of booting the real entry point, a rare "real run" reserved for critical wiring.

### Registration reach-ins: behavior, not structural

A registry queryable at runtime gets a **behavior** test: import the real barrel, assert the registry contains the entry. A structural parse only proves the *source line* exists. It stays green when the barrel can't evaluate or the package isn't installed, which is exactly when the thing is actually broken. The behavior test goes red on a deleted barrel line, a barrel that won't evaluate, *and* an uninstalled package (the unmocked import throws), so it covers the dependency integration point for free.

Two consequences. First, **don't mock the adapter's package in the shipped test**: that would defeat the dependency check, and the test runs in the composed install where the package is present. Second, the only reason to fall back to a structural parse is an adapter with real import-time side effects (spawns a process, opens a socket, needs creds at load), which is an adapter smell to fix, not a reason to weaken the test. Conformant adapters do all side-effectful work in the factory or `setup()`, never at import.

### Test archetypes

The test matches the kind of integration point:

- **In-process seam with core** (a channel into the router, a pusher into the central DB): drive the real added component against the **real core collaborators** (DB, registry, router), faking only the external edge. The highest-value archetype: it exercises the added file's consumption of core, which is what catches core drift.
- **Wiring / registration** (a barrel import, a `main()` call, an entry in an `mcpServers` map): behavior test via the registry where queryable (see above); structural / AST test where not.
- **Config / container probe** (mounts, Dockerfile, a tool installed in the image): run the change where you can. Spin up a container to confirm a mount or binary. Checking that a line exists in a file is the last resort.
- **Agentic run** (operational, instruction-only skills): run the workflow with a small model; did it complete?
- **Patch behavior** (a patch skill that changes core logic): a behavior test of the changed behavior.
- **Provider (multi-point)**: a non-default agent backend reaches into *two* barrels (host `src/providers/index.ts`; container `container/agent-runner/src/providers/index.ts`), plus Dockerfile edits and a CLI or SDK dependency. Each is a separate way to break, and each needs its own guard. Ship a **barrel-driven registration test per tree** that imports *only* the real barrel and asserts the registry contains the provider. **The trap:** a `*.factory.test.ts` that imports the provider module directly self-registers it and stays green when the barrel line is deleted; that's a unit test, not a registration guard. REMOVE.md must reverse both barrel lines, all copied files in both trees, the dependency, and the Dockerfile edits.
- **Content / instruction-only** (a reference wiki, a pure workflow): makes no functional reach-in, so it owes no integration test. Conformance is anatomy: idempotent apply, plus REMOVE.md iff apply leaves anything behind.

### Dependencies are integration points

A skill that installs a package has made a reach-in: the code now assumes it's there. Guard it so a missing package goes red, in order of preference:

1. **An unmocked import in a behavior test**: the test imports real code that imports the package, so a missing package throws. Covers presence *and* exercises the real dependency.
2. **The build leg**: a typed import of a missing module fails typecheck. The fallback when the package genuinely can't be imported in a test (e.g. it binds a port on import). Only works if the validate step runs the build before or alongside the tests, so verify the order.
3. **A Dockerfile-installed CLI binary** is the case most often left unguarded: it isn't importable, so neither guard above sees it. Use a **structural test** asserting the Dockerfile `ARG <X>_VERSION=` and install line are present, optionally backed by a `<bin> --version` container probe. Pin the version; reject `latest`.

You do *not* need to test the dependency's own API contract; that's optional external-service coverage.

### When there is genuinely nothing to test in-tree

Some skills' only functional integration is a runtime operator action with no source footprint: registering an MCP server through `ncl`, or a mount through the sanctioned query wrapper (until the `ncl` add-mount verb lands). There's no line in the tree whose deletion a test could catch, so a registration test is structurally inapplicable. **State this explicitly in SKILL.md** rather than inventing a hollow test; conformance is then anatomy plus the dependency guard. This is a conformant outcome, valid only when the reach-in has no in-tree representation. (A raw-SQL write into core's schema to achieve the same thing is a smell, not a workaround.)

### Test rules

- **Hermetic at the external edge.** Mock genuinely external services (a fake HTTP server, stubbed creds), never the package under guard (see "Registration reach-ins").
- **Exercise the real entry, or assert it structurally.** A test that imports the skill's function directly does not test the integration.
- **Tests travel with the skill** and are copied in on apply; an integration test only means anything against the composed project.
- **Robustness check.** Apply the skill with a small, cheap model. If a small model fumbles the instructions, they're too vague. Fix the instructions, don't blame the model. (Small models also keep applying skills cheap.)

---

## Anti-patterns

Each with its fix. These are patterns to remove, not to test around: a drift-prone, untestable reach-in is usually a symptom of a bad pattern, not a missing test. Reviewers reject them; the conformance linter will flag them automatically.

1. **A separate VERIFY.md.** Delete it; tests are the verification. Fold any genuinely useful manual smoke check into SKILL.md's next steps.
2. **REMOVE.md soft-disable** (comments out an import; leaves copied files behind). DELETE the import line and `rm` every file the skill copied.
3. **REMOVE.md incomplete** (misses env vars, the package uninstall, copied tests). Reverse *every* change; read the env vars from the skill's own credentials section, don't guess.
4. **Raw SQL against a core DB** (read or write). Use a core helper or an `ncl` verb; the in-tree query wrapper is the sanctioned last resort. Never the `sqlite3` binary.
5. **Credential threading** (`-e KEY=…` or a stdin secrets payload into the container). OneCLI gateway only; it injects credentials per request.
6. **Branch-merge install** (`git merge` of a registry branch or any code branch). Install by additive fetch: `git fetch origin <branch>`, then `git show origin/<branch>:path > path` per file. For an update/reapply workflow, re-run each installed skill's additive apply, never merge.
7. **Diff-against-past framing** ("earlier versions…", "this is now redundant") and **documenting non-steps** ("no X needed"). Write present-tense DO steps only. A skill reads as a standalone artifact with no memory of its own edits.
8. **Stale reach-in targets** (an edit aimed at code that no longer exists; a reach-in already shipped in trunk). Verify the target exists *before* instructing the edit; reconcile already-in-trunk ones to a no-op. Before appending to an allowlist or list, check how it's consumed; the entry may already be derived from a registry, making the edit dead.
9. **Hand-maintained duplicate copies** (a mirror directory kept in sync by hand or sed). Generate the mirror from a single canonical source.

---

## Worked examples

In-tree exemplars for the code archetypes. (Two carry known smells, kept deliberately pending architectural fixes; they demonstrate the test shapes, not perfection.)

- `add-dashboard`: in-process seam with core (the pusher against the central DB), plus an AST wiring test for its `main()` call.
- `add-slack`: Chat SDK channel registration; the template for the whole channel family.
- `add-deltachat`: native channel registration.
- `add-atomic-chat-tool`: MCP-tool wiring across both runtimes (container registration and host env-helper call).
- `add-opencode` / `add-codex`: the provider multi-point archetype, with two barrels, Dockerfile pins, and per-tree registration tests.
