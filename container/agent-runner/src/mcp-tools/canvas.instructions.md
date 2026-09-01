## Canvases

Slack canvases are shared documents that live alongside a conversation. The **room canvas** is the room's shared working surface: chat is for coordination, the canvas is for state. It has named sections — **Members**, **Tasks** (a checklist), **Decisions**, and **Notes** — and both humans and agents edit it. The canvas id (`F…`) for a room is in your destinations list — the `<room> canvas comments (canvas F0…)` destination carries it (canvas ids are uppercase, starting `F`). If you can't find it, ask in the room — never guess an id.

Two tools:

- `mcp__nanoclaw__canvas_update({ canvas_id, op, markdown, section_text? })` — fire-and-forget edit. `op` is `append` (at document end), `replace_section`, or `insert_after_section`; the last two need `section_text` — the target section's **exact heading text**. Outcomes: a FAILED edit wakes you with a system note saying why — fix and retry from a fresh read. A successful edit's note is silent (it rides along on your next wake), so verify structural changes with `canvas_read`.
- `mcp__nanoclaw__canvas_read({ canvas_id, timeout? })` — blocking read; `timeout` is in **seconds** (default 20 — never pass milliseconds). Returns the canvas as readable text, checkboxes rendered as `[ ]` / `[x]`, truncated at ~8000 chars — a `…[truncated at N chars]` suffix marks the cut, and sections may exist below it, so never conclude a section is absent from a truncated read. A "timed out" error can occur even when the host read succeeded — retry once, with a larger `timeout` on slow canvases.

Section targeting: `section_text` must be the exact heading text (matching is case-insensitive and trimmed; exact match beats contains; ties go to the first matching heading in document order). If it matches only body text — or the host's pre-read transiently fails — the op silently degrades to a **single-block** edit that can corrupt the section. Full mechanics live in the `canvas-work` skill; follow it for every edit.

Working rules:

- **Keep Tasks and Decisions current.** When work is agreed, ADD it under Tasks with `insert_after_section` (markdown = just the new `- [ ]` line — existing items and their ticks stay intact). Checkbox tick state is **UI-only**: the API ignores `- [x]` and a section rewrite resets every ticked box, so mark completion by editing the item's own text (see the `canvas-work` skill) and leave box-ticking to humans. When a decision lands in chat, record it under Decisions — quote the ask, name who decided.
- **Section-scoped edits only.** Always target one section (`replace_section` / `insert_after_section`) or append. Never try to rewrite the whole document — whole-document replace is destructive to everyone else's edits and the tools will not do it.
- **Read before your edits, read after structural ones.** Human edits fire no events, so your memory of the canvas is stale by default. One fresh `canvas_read` covers all the edits you compose in the same turn; after adding or reordering sections, `canvas_read` again to confirm. Humans may also tick checkboxes — re-reading is how you notice.
- **Batch small edits.** Each bot edit posts a (debounced, but real) "updated the canvas" notice in the conversation. Compose one edit per section per work burst, not one edit per line.
- Rich content that works well in canvas markdown: checklists, tables, user cards `![](@U…)`, message permalinks (paste the link — it becomes a card), code blocks, and blockquotes for decisions.

### Canvas comments

Comments people leave on a canvas reach the room's agents as ordinary messages in a separate channel named `<room> canvas comments` — one per canvas, wired to EVERY agent in the room. If you created the canvas, you are its default responder: every comment engages you. Otherwise comments reach you as ambient context only, and you respond when @-mentioned in one. A comment that @-mentions a sibling wakes BOTH that sibling and the creator — creator: when a comment tags someone else, let them answer; stay silent unless you're needed.

- Comments arrive as **threads**. The thread's ROOT message is from **USLACKBOT** and its text is the exact canvas text the person commented on (e.g. the checklist line) — that is your anchor context for what the comment is about. The human comments are the replies under it.
- **Reply in the same thread** to answer a comment. Your reply may appear to the commenter as a native canvas comment reply — treat the thread as the comment conversation.
- **Never reply to messages authored by USLACKBOT itself.** The anchor roots and the `<@…> was mentioned in a canvas` notices are system noise. If you are the creator, one of these can itself be the message that WOKE you — being woken by it is not a request to answer it. Read it for context (e.g. `canvas_read` on a mention notice), reply only to human messages that need one, and if nothing does, ending your turn with no message is the correct outcome.
- When woken in a comments channel without any @-mention (creator), your prompt is the **newest human comment** in the batch.
- After addressing feedback: update the relevant canvas section (via `canvas_update`), then reply briefly in the comment thread so the commenter knows it's done.

## Mention notices and finding context

- The comments channel name carries the canvas id: `<room> canvas comments (canvas F0…)`.
- When a "<@…> was mentioned in a canvas" notice arrives (or a comment lacks enough
  anchor context), do NOT ask the user what they mean first — call `canvas_read` with
  that canvas id, find the mention or the referenced section yourself, then respond
  with the context in hand. Only ask if the canvas genuinely doesn't disambiguate.
