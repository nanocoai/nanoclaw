---
name: canvas-work
description: >-
  Edit Slack canvases without corrupting them — read-before-write, section
  targeting by heading, replace vs insert discipline. Use EVERY time you
  edit a canvas with canvas_update (room canvases, task lists, deliverable
  docs), not just the first time.
---

# Canvas Work

Canvases are shared documents. Human edits fire no events, so your last view
is stale by default. Every edit is section-scoped; the wrong op duplicates
content instead of updating it.

## When to use a canvas

- **Large outputs go in the canvas, not chat.** Any prose or code deliverable
  longer than ~a dozen lines — a plan, report, spec, analysis, draft, long
  diff — goes into the canvas (the right existing section, or a new one) and
  the chat message shrinks to a 1-3 line summary plus a pointer ("Full plan
  in the canvas under Rollout"). Chat is for coordination; canvas is for
  content. Binary artifacts (charts, PDFs, images) still go via `send_file`.
- **Placement for a new deliverable**: a genuinely new section, not stuffed
  into Notes — `insert_after_section` after the most related section, or
  `append` when it belongs at the document end.
- **Collaborative state lives there**: task lists, decisions, running notes
  that humans and agents co-edit.
- In a DM with no canvas, a long deliverable may stay a chat message — but
  where a canvas exists, prefer it (there is no canvas-create tool; "new
  structure" means a new section on an existing canvas).

## The loop

1. **Read first.** `canvas_read` before editing — never edit from memory or
   a previous turn's read. One fresh read covers all the edits you compose
   in the same turn. Read-backs truncate at ~8000 chars with an explicit
   `…[truncated at N chars]` marker: if you see it, the canvas continues
   below what you read — never conclude a section is absent from a
   truncated read (heading-anchored edits still resolve against the full
   canvas host-side, so editing below the cut is safe).
2. **Locate the target** in the read-back. For section-wide edits,
   `section_text` is the exact heading text — a body-text anchor silently
   degrades a section rewrite into a single-block edit that corrupts the
   section. For checklist items, a body-text anchor (the item's exact
   text) is the CORRECT, deliberate way to target that one item (see
   Checklists).
3. **Pick the op:**
   - `replace_section` — the content EXISTS and you are changing it (ticking
     a box, updating status, rewriting a paragraph). Updates always use this.
   - `insert_after_section` — a genuinely NEW section, one whose heading
     appears nowhere in the canvas, placed after a specific section.
   - `append` — content for the document END: log entries, list additions,
     or a new final section (markdown starting with its new heading).
4. **Never create a heading that already exists** — anywhere in your
   markdown, not just the first line. A best-effort host guard refuses
   obvious duplicate-heading inserts (the refusal wakes you with a note),
   but it is narrow — the rule is yours to enforce, the guard is not a
   backstop. Note: appending log entries whose markdown repeats the log
   section's heading is the classic way to trip it — append entry lines
   only, no heading.
5. **Batch small edits**: one `canvas_update` per section with the complete
   new section markdown, not a burst of tiny ops.
6. **Verify structural changes.** A FAILED edit wakes you with a system
   note saying why — fix from a fresh read. A success note only rides along
   on your next wake, so after adding, reordering, or rewriting sections,
   `canvas_read` and confirm the result before reporting done. Never report
   a structural edit as landed that you haven't re-read.

## Checklists: item-level ops only

Tick state is **UI-only** — a hard platform limit, live-probed: `- [x]` in
edit markdown is silently ignored (items always land unticked), and any
section rewrite RESETS every ticked box (the host warns you when that
happens). So on checklists:

- **Add an item**: `insert_after_section` on the section heading, markdown
  = just the new `- [ ] item` line. Existing items and their ticks stay
  intact. Never re-send the whole list to add one item.
- **Mark an item done**: you cannot tick its box. Edit the ITEM itself —
  `section_text` = the item's exact text (a non-heading match targets that
  single item), op `replace_section`, markdown like
  `- ✅ deploy the site (done)`. Humans tick boxes; agents mark done in
  the item text.
- **Remove or reword an item**: same item-level targeting.
- **Rewrite the whole section only when resetting it is the point** (e.g.
  replacing placeholder content) — every ticked box comes back unticked.

### Worked example: mark a task done

User: "mark the deploy task done."

1. `canvas_read` → Tasks contains `- [ ] deploy the site` and
   `- [ ] write the announcement`.
2. Item-level edit — target the item, not the section:

   ```
   canvas_update  op=replace_section  section_text="deploy the site"  markdown:
   - ✅ deploy the site (done)
   ```

   A full-section rewrite here would land, but with every checkbox reset
   and no way to express the tick.

For NON-list sections, `replace_section` on the heading swaps the whole
section region — send the complete section markdown, heading included.
Lines you omit are deleted.

## Section model

- A section region is a heading plus every block down to the NEXT heading
  (canvases have three heading levels; any of them ends the region).
  Sub-headings end the region: `replace_section` on `## Tasks`
  when it contains `### Sprint 1` replaces only the blocks above the `###`
  and leaves every subsection in place — resending subsection markdown
  duplicates it below the new content. Edit the parent's intro and each
  subsection as separate ops.
- **Always include the heading line** in `replace_section` markdown. The
  heading block itself gets replaced: omit it and the section visually
  merges into the one above and can never be heading-targeted again.
- These region semantics apply only when `section_text` matches a heading.
  A body-text match targets ONE block — deliberate and correct for
  checklist items, silently corrupting for section rewrites. Know which
  edit you are making.
- `insert_after_section` inserts after the region's last block, not directly
  after the heading.

## Pitfalls

- Heading matching: case-insensitive, trimmed; exact match beats contains;
  contains ties go to the FIRST matching heading in document order (`Task`
  hits `Tasks` before `Task archive`). Use the full exact heading.
- Section ids are ephemeral; the host re-resolves them on every edit.
  Heading text from a fresh read is the only reliable addressing.
- `canvas_update` is fire-and-forget: failures wake you with a system note
  (fix from a fresh read); success notes arrive silently on your next wake.
  For anything structural, `canvas_read` is the confirmation.
- **Partial replace**: if a read-back (or a failure note) shows your new
  content in place with old blocks of the same section still sitting below
  it, re-issue the SAME `replace_section` on the same heading — the
  leftovers are now that region's body, so the identical retry is the
  idempotent fix. If the retry leaves the SAME leftovers again, those
  blocks are unaddressable host-side — stop retrying and tell the human
  (they can delete them in the canvas UI). For anything else that looks
  wrong, re-read and compose a fresh edit.
- `canvas_read`'s `timeout` is in seconds (default 20). A timeout error can
  fire even though the host read succeeded — retry, optionally with a
  larger timeout.
