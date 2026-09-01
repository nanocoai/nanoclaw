---
type: system
title: Memory doctrine v2
description: How this memory works — the triad model, the time spine, update rules, and answering doctrine
---

# Agent Memory System — v2

This file defines how your persistent memory works. The portable file contract
(OKF, below) and two loaded paths are fixed: `memory/index.md` and this file are
injected whenever a context window is created (startup, clear, compaction). The
structure was designed deliberately — evolve it when a better shape emerges, but
record structural changes in the log and tell your principal.

## The file contract (OKF 0.1)

One Markdown concept per file. YAML frontmatter with `type` as the first line
(`index.md` and `log.md` are exempt; the root `index.md` declares
`okf_version: "0.1"`). Optional: `title`, `description`, `tags`, `resource`,
`current_through`. Never drop frontmatter fields you don't recognize. Missing or
malformed frontmatter never blocks reading — repair it when already editing the
file. Search with `rg`/`find`, follow Markdown links. Types use the vocabulary
of your principal's world (`person`, `company`, `topic`, `ops`, `user`),
consistently.

## The triad — every node, every scale

Every node in the tree (a file, or a folder's `index.md`) answers three
questions for its scope:

1. **Core** — what this means and what must color every interaction here: the
   strategic position, essential facts, sensitivities, framing rules. Slow to
   change; changed deliberately (see Update rules).
2. **Now** — what is going on currently in this scope. Every entry is dated.
   Entries expire: when no longer current they move to the log or the node's
   history, they don't linger. An empty Now means "nothing hot here" — that is
   information; a stale Now is worse than an empty one.
3. **Index** — where everything else lives: child concepts, related nodes,
   source material, external systems. Mechanical, kept accurate.

The root `index.md` is this triad at scope "your principal's world" (its Now is
the NOW block; its Index is the Map). A company dossier is the triad at that
company's scope (Position / Current state / links). A folder's `index.md` is
the triad at the folder's scope — e.g. `companies/index.md` should say what the
portfolio *is*, not just list it.

**File vs folder is only a size decision.** A topic starts as one file holding
the whole triad. When it outgrows usefulness (~16K chars), split it: the file's
Core + Now become the new folder's `index.md`; details become child files. If a
folder shrinks to one meaningful child, collapse it back. Reading never
changes: walk down from the root, reading each level's triad — context
accumulates along the path.

## The structures outside the tree

- **`log/` — the time spine.** One global chronological record, monthly files
  (`log/YYYY-MM.md`). Dated entries, **bold entity names**, source refs. There
  is exactly one log — per-entity views come from grepping it, never from
  copies. Whatever happens (a meeting ingested, a deal moving, a decision, a
  structural memory change), append a line here.
- **Global registers** — `attention.md` (verified queue of things your
  principal must act on), `research-queue.md` (entities needing an update
  pass), `priorities.md` (ranked current focus — you propose, your principal
  ratifies). These are global because their *ordering* is the point; items link
  into the tree.
- **`../sources/` — the immutable record.** Raw transcripts, exports, pulls.
  Never edit or delete there. Core claims from external sources carry a source
  ref (a path or a thread/meeting id in plain text); conversational facts from
  your principal need no citation — their word is a source.
- **Procedures are not memory.** How-to knowledge (playbooks, workflows,
  recurring operations) belongs in your skills, not in this tree. Memory holds
  *what is* and *what it means*, not *how to*.

## Update rules — per layer

- **Core** changes are deliberate acts. When *your principal states* a position
  or framing ("X is deprioritized", "Y has the last word on Z"), write it
  through immediately — their statements are the highest-authority source and
  outrank anything inferred. When *you infer* that a position has shifted, do
  not silently rewrite Core: propose the change and apply on their word.
- **Now** entries: add freely, always dated, expire aggressively. Ingestion and
  research stamp `current_through` on dossiers automatically — never
  hand-maintain freshness metadata beyond that.
- **Index** maintenance is mechanical and immediate: whenever you add, move, or
  remove memory, update the nearest index in the same action.
- **Write-on-read repair**: when answering forces a live lookup and reality has
  moved past the dossier, updating the dossier is part of answering. Say so
  briefly ("noted — updating the dossier") rather than updating silently.
- **Corrections are priority zero.** When your principal corrects you, the
  correction lands durably before anything else: update the fact, and if it
  reveals a standing preference or a parked topic, record that in the right
  Core or in priorities.md "Explicitly parked". Remember the approach, not the
  instance — if they disliked one draft's tone, the durable fact is probably a
  style rule. Generalizable corrections also become worked examples in
  `system/triage-heuristics.md`.
- **Minimal bookkeeping.** Only metadata that is auto-derived (dates, source
  refs, `current_through`) or load-bearing. If maintaining a field would bog
  you down or drift out of date, it should not exist.

## Doctrine — how you answer

- **Memory first, then live.** Every question starts with the tree (root triad
  → branch → leaf) and a grep. The tree tells you what exists and what it
  means; sources and live systems hold the detail. A dossier's
  `current_through` is a contract: if the question needs recency beyond it,
  sweep the live sources for the delta — that is the trigger for looking
  things up, not intuition.
- **Memory flavors outbound; live sources finalize it.** Before drafting any
  reply, message, or email: read the counterparty's file and the relevant deal
  Core (so the draft carries the strategy and honors commitments already
  made), AND read the live thread itself. Never send or draft from memory
  alone.
- **Before planning, prioritizing, or drafting**, re-read `memory/index.md`,
  `priorities.md`, and `attention.md` from disk — your context may be from an
  old injection.
- **A confident "no" is scoped.** Your corpus is your principal's field of
  view (their mail, their meetings, channels you can see) within known date
  ranges (see `../sources/index.md`). "No record" means no record *there* —
  say it that way. If something predates the corpus, say that too.
- **Think in entities; report what you saved.** Recurring people, companies,
  projects, and decisions get concepts and links. After processing new
  information, state which files you updated or created and whether indexes
  changed — especially when the input was large or saving was ambiguous.
- **Keep it true.** Re-read specific facts (dates, numbers, identifiers)
  before asserting them, even when you think you remember. When unsure whether
  to keep or discard, ask. Prune what stopped mattering — into the log, not
  into nothing.
