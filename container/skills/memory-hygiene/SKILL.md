---
name: memory-hygiene
description: Audit, consolidate, and re-index your own memory tree — repair indexes that drifted from disk, settle contradictions, normalize dates, and prune what is safely superseded. Use when the memory-maintenance task fires, when the user asks you to clean up your memory, or when your indexes no longer match what is on disk.
---

# Memory Hygiene

You wake with no working memory. Everything you know about this user lives in
`/workspace/agent/memory/` — and it decays: indexes drift from what is on disk,
corrected facts leave their old version behind, "next week" becomes last month,
and one fact accumulates three homes. This is the pass that repairs that.

**The tree is the source, not the transcripts.** Everything this pass does —
repairing indexes, promoting a concept, moving a file to a better folder — is
derived from reading `memory/` itself. Conversation history is a last-resort
tiebreaker for a contradiction you cannot settle from the tree, capped at the
current window. Never mine weeks or months of transcripts: that is a large,
slow, expensive read that this pass does not need and must not attempt.

One pass runs at a time — nothing serializes two of them against the same tree.

**Before you start.** Re-read from disk — `memory/` is a bind mount and this
session may have been resumed many times since it last loaded the tree, so any
copy in your context is a guess. Then find your window: scan `memory/log.md`
backwards for the most recent `## [YYYY-MM-DD] hygiene` heading. No heading (or
no file) means this is the first pass — create it, and take the whole tree.

## 1. Orient

Read only. `memory/index.md`, every `index.md` in the tree, every concept file
the Map points to, and `memory/system/definition.md` (this group's own
doctrine, which may have been improved since you last read it and outranks your
habits).

Note without acting, and keep the list — it is the whole worklist for this pass:

- **Structural:** indexes listing files that no longer exist, files no index
  mentions, a folder that has grown past what its name covers, a file sitting in
  a folder that no longer describes it.
- **Factual:** claims that feel superseded, one entity with two pages, relative
  dates, passed deadlines with no outcome.
- **Conceptual:** a term several files lean on with no page of its own — count
  the files that reference it; that count is your evidence, not a memory of
  someone saying it.

Everything after this confirms or drops those suspicions.

## 2. Signal

Almost everything you need is already in the tree. `grep` it: which files
mention an entity, which reference a term, which index points where. That is
your evidence for promotion and reorganization, and it costs one read of a
directory you have already loaded.

Reach outside the tree **only** for a contradiction you cannot settle from the
tree, and stop the moment it is settled:

- `/workspace/agent/conversations/*.md` — date-prefixed summaries. Cheap. Try
  these first.
- `ncl sessions list`, then `ncl sessions history <session-id> --limit 200 --json`
  — the complete durable record, for when a summary does not cover it. There is
  no `--since`: pull the newest rows and drop everything at or before your
  window's start.

If a contradiction still will not resolve, that is a reporting outcome, not a
reason to widen the read. Leave both claims, flag it in the log, and move on.

## 3. Consolidate

- **Correct contradictions at the source.** One version survives; don't keep
  both and hedge.
- **Normalize dates.** "Last week" becomes the date. Passed deadlines resolve
  into an outcome or go.
- **Write to the smallest file that owns the fact**, updating the entity's
  existing page rather than adding a second home.
- **Promote a concept the tree is already carrying.** When several files lean on
  the same term and none defines it, give it its own file and link it from the
  entities that reference it. The threshold is what you can point at in the
  tree — three files referencing it, say — not a hunch that it matters.
- **Compress without destroying.** The test for every cut: *if this were
  deleted, would a future session make a worse decision?* If yes, it stays.
- **Preserve OKF frontmatter.** `type` stays the first line; never drop a field
  you don't recognize; repair malformed frontmatter on files you're already
  editing.

## 4. Reorganize, prune, index

**Reorganize when the tree has outgrown its shape** — a folder holding two
unrelated kinds of thing, a file whose folder no longer describes it, a folder
of one item that belongs in its parent. Move for a reason you can name in the
log, and move in whole steps: relocate the file, fix every index that pointed
at it, fix every `[[link]]` that referenced it. A half-finished move is worse
than the layout you started with. If you cannot complete it in this pass, don't
start it — note it in the log for next time.

**Then index.** Every index matches its folder, and you fix that in one
direction only — **by editing the index, never by creating the missing file.**

- **Dead pointer** (index names a file that does not exist): delete the line.
  Do **not** write a stub to satisfy it. An index label is a pointer, not
  evidence; turning "- [Rami](rami.md) - former contractor" into a `rami.md`
  that asserts Rami is a former contractor invents a fact from a link, and the
  next pass will read it back as something the user told you. If the label
  looks like it was carrying real information, say so in `log.md` — that is the
  right home for a fact with no source.
- **Unlisted file**: add it to the index.

Core Memory in `memory/index.md` holds only what's relevant in nearly every
conversation. Actively demote the rest — equipment specs, one-off preferences,
anything you would not use in most turns — into the entity file that owns it,
and promote anything that has become that load-bearing. Leaving Core Memory as
you found it is a skipped step, not a conservative one.

**Repair frontmatter on every file you touched this pass.** If you edited a
file, its frontmatter must come out valid: `---` fences present, `type` first,
unknown fields preserved.

Finally, append your entry to `memory/log.md`.

**Deletion rule.** Delete a fact **only** when it is clearly obsolete **and**
already safely represented elsewhere. Uncertain history stays. "Not mentioned
lately" is not obsolete — people go quiet about things that still matter. If
something looks stale but you can't show where it's safely represented, leave it
and say so. These passes run unattended and deletions are unrecoverable.

**Invention rule.** Never add a claim this pass did not find. Every fact you
write must already exist in the tree or in the record you read — you are
reorganizing what is known, not filling gaps. A tidier tree that asserts one
thing nobody said is a worse tree, because the next pass cannot tell your
inference from the user's own words.

## Boundaries

You may change anything under `/workspace/agent/memory/`. You may not change
`instructions.prepend.md` (the standing persona — read it for context),
`CLAUDE.md`/`AGENTS.md` (regenerated every spawn), `conversations/*.md` or
session history (sources you read, never rewrite), or anything outside the
memory tree.

## Logging and reporting

**`memory/log.md`** is the durable record — append-only, newest at the bottom,
no frontmatter needed. One heading per pass so the next pass finds its window:

```markdown
## [2026-08-23] hygiene

- Repaired: projects/index.md listed atlas-migration.md (deleted 2026-08-04)
- Corrected: dana.md said "leads Atlas"; superseded 2026-08-11 — now "advises Atlas"
- Promoted: "design partner" referenced by 4 files, no page — now concepts/design-partner.md
- Moved: vendors/tooling.md → tools/index.md; vendors/ was holding two unrelated kinds
- Flagged, not deleted: vendors/acme.md unreferenced since 2026-06 — no other home for the pricing terms
```

**The run log** takes your final line automatically and **truncates it at 500
characters**, so make it one sentence naming the biggest changes and stop —
a compound sentence listing everything gets cut off mid-word. The detail belongs
in `memory/log.md`, which has no limit. Nothing about how the turn was
delivered, retried, or prompted belongs in this line; it is a record of what
changed in memory.

**A chat message** goes out only when a human must decide something — a
contradiction you can't settle from the record, a deletion you want confirmed.
That needs an explicit `<message to="<destination>">` block; without one nothing
is sent, which is the right default. Silence when nothing changed is a feature.

## Goal

The next cold start reads itself back into existence and finds a mind that is
current, coherent, and honest about what it knows and what it does not.
