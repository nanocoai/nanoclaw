---
name: learn
description: "Distill a reusable skill from anything — a directory, a URL, pasted notes, or what you just did together — or refine an existing skill with new learnings. Use when the user says '/learn', 'learn this', 'turn this into a skill', 'capture this workflow', 'make a skill from <source>', or 'improve/update the <name> skill'. Produces or updates a .claude/skills/<name>/SKILL.md authored to NanoClaw's skill guidelines. (This CREATES or REFINES a skill from a source; it does not install existing skills from a registry.)"
---

# Learn — Distill a Skill from Anything

Turn a source — a directory, a URL, pasted notes, or the work just done in this conversation — into a clean, reusable NanoClaw skill. The output is a new `.claude/skills/<name>/SKILL.md` (plus optional `scripts/`, `references/`, `templates/`) authored to the project's skill guidelines.

This skill is **instruction-only**: it uses the tools you already have (`Read`, `Grep`, `Glob`, `WebFetch`, `Write`) — there is no separate distillation engine and no reach-ins into core code.

## When to use

Invoke when the user wants to *capture* a workflow as a reusable skill:

- `/learn <path>` — read a project/dir and build a skill for working with it
- `/learn <url>` — read docs / an API page and build a usage skill
- `/learn what we just did` — distill the current conversation's workflow
- `/learn` + pasted notes — turn notes into a structured skill

If the user instead wants to *find and install* an existing community skill, that is a different task — this skill **creates** new skills, it does not import them.

## Workflow

### 1. Identify the source — and whether this is a new skill or a refine
- A **path** → read the code/files.
- A **URL** → fetch and read the page.
- **"what we just did" / "this"** → use the current conversation as the source.
- **Pasted text** → use it directly.

Then check `.claude/skills/` for an existing skill that already covers this topic (the user may name it, e.g. *"update the wow-on-steam-deck skill"*, or the subject may obviously match one). **If one exists, this is a REFINE, not a fresh create** — go to step 4's "Refining" branch.

If it is ambiguous what the skill should *do*, ask one clarifying question before proceeding.

### 2. Gather the material
- **Path:** `Glob` the structure, `Read` the key files, `Grep` for the important entry points. Read enough to understand the *repeatable procedure*, not every line.
- **URL:** `WebFetch` the page; pull out the concrete commands/steps, not the prose.
- **Conversation:** re-read what was actually done — the commands, the gotchas, the decisions — and keep the parts that generalize.

### 3. Distill — find the reusable procedure
Strip the one-off specifics; keep the *repeatable* shape. A good skill answers: *"Next time someone needs to do X, what are the exact steps, files, commands, and gotchas?"* Capture:

- the trigger / when-to-use,
- the step-by-step procedure (commands, file paths, decision points),
- the non-obvious **gotchas** that were hit — usually the most valuable part,
- any scripts or templates worth shipping alongside.

### 4. Author the SKILL.md

**Refining an existing skill?** First `Read` the current `.claude/skills/<name>/SKILL.md`, then *update it in place* — do not blindly overwrite:
- Keep what is still correct; weave the new learnings into the right sections.
- **Dedupe** — don't append a near-duplicate step or a second gotcha that says the same thing.
- Correct anything the new source proves stale (a changed path, command, or flag).
- Preserve the existing `name`/folder and overall structure; the diff should read as a focused improvement, not a rewrite.

**New skill?** Write `.claude/skills/<kebab-name>/SKILL.md`.

**Frontmatter (required):**

```yaml
---
name: <kebab-case, matches the folder>
description: "<what it does + when to use it + likely trigger phrases>"
---
```

`description` is what the agent reads to decide relevance — make it concrete and include the phrases a user would actually say.

**Body:** open with one paragraph on what the skill does, then a `## When to use` section and a `## Workflow` of numbered steps (the actual procedure). Use tables for command/file references, and add a short examples or troubleshooting section when the gotchas warrant it.

**House authoring rules (from `docs/skill-guidelines.md`):**

- **Additive, minimal reach-ins** — prefer adding files; make the *smallest possible* edit to existing code, and only via single-line calls into skill-owned functions.
- **Instruction-only when possible** — if Claude can do it by following prose plus existing tools, ship no code. These are the easiest skills to maintain and to merge.
- If apply leaves anything behind, ship a **`REMOVE.md`** that fully reverses every change (no soft-disabled/commented-out removals).
- If the skill adds an integration point in core code, add a **test that goes red if the wiring is deleted or drifts**.
- Anti-patterns to avoid: separate `VERIFY.md` files, incomplete cleanup, raw SQL against core DBs, branch merges (use additive fetch), hand-maintained duplicate copies.

### 5. Place and verify
- Write into `.claude/skills/<name>/`; confirm the folder name matches the `name` frontmatter and the YAML parses.
- If feasible, dry-run the procedure the skill describes to confirm it is correct.
- Tell the user the skill exists and how to invoke it (`/<name>`).

## Example

`/learn what we just did` after a multi-step setup:

1. Re-read the conversation's commands and gotchas.
2. Distill the repeatable procedure.
3. Write `.claude/skills/<topic>-setup/SKILL.md` with the steps, file paths, and the gotchas hit along the way.
4. Report: *"Created `/<topic>-setup` — invoke it next time to repeat this."*

## Notes

- Keep skills **focused** — one capability per skill (mirrors the project's "one change per PR" rule).
- The most valuable content is the **gotchas**, not the happy path.
- This skill is prose and safe to re-run — use it again to refine an existing skill.
