---
name: knowledge-inventory
description: Show the user a plain-language picture of what you know, remember, and track about them. Use when the user asks what you know about them, what you remember, what you have learned, or what you keep track of — and when they ask to see everything under one of those categories.
---

# Knowledge Inventory

When the user asks what you know about them, show them **the shape of what you keep** — the kinds of things you track, roughly how many of each, a couple of examples, and the durable facts about them — then offer to add, fix, or stop tracking anything.

A tidy notebook, not a database dump. You are showing a person their own world, not your storage.

## 1. Check first, before you answer

Confirm `memory/index.md` is the active store for this group. If it is missing — or the group still keeps its durable content in a legacy `CLAUDE.local.md` — do **not** improvise an inventory and do **not** describe the files.

Say memory isn't set up yet, and phrase the next step as something for the user to **forward to whoever set you up**, never as something they run:

```text example-output
I'm not set up to keep track of things yet, so I don't have anything to show you.
If you'd like that turned on, pass this to whoever set me up: my memory setup
needs to be finished first.
```

Then stop. An honest blank beats a plausible invention.

## 2. Read what is actually there

1. `memory/index.md` — the durable facts about the user (the Core Memory section) and the map of folders.
2. Walk the folder `index.md` files the map points to. Each folder is a category: **count its real entries** and pick 2–3 real entry names as examples.
3. Optionally check which entries have the newest dates, for a "recently started keeping track of…" line.

**Count from the folders. Never estimate, round, or infer a category that isn't there.** If a folder holds 3 entries, it is 3 — not "a few". If memory is nearly empty, say so.

**Report every folder the map points at — with one exception.** Skip the memory's own definition (`system/`): that's how your memory works, not something you keep about the user. Everything else gets a line, including folders that look like your own operational notes. Don't silently drop a category because it seems uninteresting or internal — a picture with something quietly missing is worse than one that includes a line the user waves off, and they can only tell you to stop tracking something they can see. If a folder really is about your own operation, still name it plainly and say what it's for.

## 3. Translate structure into the user's words

This is the real work of this skill. Nothing internal reaches the user.

| What you read | What you say |
|---|---|
| Core Memory lines in `index.md` | An **"About you"** section — the durable facts, in plain words |
| A folder of `type: customer` entries + its index | A category line: **"Your customers — 12"**, plus 2–3 example names |
| A folder with few entries | The same, with the honest small count: "Your suppliers — 3" |
| Newest-dated entries | Optional: "Recently started keeping track of: …" |
| Empty or scaffold-only memory | An honest "not much yet" message |

Use **the user's vocabulary** — the names the memory already uses come from their world. Pluralize and prefix naturally: "your customers", "projects you're running", "people you work with". If the internal type name is `customer`, say "your customers".

**Never say, in any surface:** `memory/`, `index.md`, "index", "concept file", "OKF", "entity type", "frontmatter", "Core Memory", "scaffold", "store", or any file path.

That list is examples, not the whole rule. **The rule: no word that describes how your memory is built.** "I haven't picked up much yet" is right; "my memory is still just the empty scaffold" is the same sentence with the machinery showing. If a word would only make sense to someone who has seen your files, it doesn't belong in front of the user — even when the honest answer is that you know nothing.

**Show the shape, not a transcript.** Categories, counts, a couple of examples. Do not recite every fact. Only expand a full list when the user asks for one specific category ("show me everything under customers") — then list that category only.

## 4. Render for the channel

Build the richest surface the channel supports; always provide the text.

**HTML file (preferred where files land).** Write a **self-contained** HTML file to your workspace — inline CSS, no external stylesheets, fonts, scripts, or images; readable on a phone. A tile or row per category with its count, an "About you" panel, optionally a recent-additions strip. Then send it:

```
mcp__nanoclaw__send_file({
  to: "<destination>",
  path: "what-i-track.html",
  filename: "what-I-track.html",
  text: "<one-line plain summary>"
})
```

The accompanying `text` is a one-line summary, not a preamble about the file.

**Plain text (always available).** If files aren't supported, or as the universal floor, send a short grouped list with `send_message`:

```text example-output
Here's what I'm keeping track of for you:
• Your customers — 12 (Ana, the downtown bakery, …)
• Your suppliers — 3
• Projects you're running — the new website, the winter catalog
• About you — you prefer short answers; based in São Paulo

Want me to add something, fix anything, or stop tracking one of these?
```

A card summary is fine on channels that render cards, but don't rely on its buttons being tappable — replies come back as free text either way. The HTML is the richer artifact; the text is the floor.

When memory is sparse or empty, the same honesty applies:

```text example-output
Not much yet, honestly — just that you prefer short answers. Tell me about your
work and the people in it, and I'll start keeping track.
```

## 5. Always offer control

Close every inventory with an open invitation:

```text example-output
Want me to add something, fix anything, or stop tracking one of these?
```

Corrections come back as ordinary replies — "stop tracking suppliers", "my city is Rio, not São Paulo", "also keep track of my competitors". Apply them by editing memory under the rules in `memory/system/definition.md`, which already governs updating and pruning — including asking before discarding anything you're unsure about. Confirm what you changed in plain words, and make sure a later re-ask reflects it.
