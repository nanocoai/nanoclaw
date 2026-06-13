# Onboarding — generate your skin from a website

**Goal:** point the skill at a site you like (your own, a competitor, a reference), and have it extract the palette + typography, then rewrite `style-guide.md` so every future diagram inherits that skin.

Takes about 60 seconds.

---

## The flow

```
URL you provide
      ↓
[1] fetch homepage (headless browser or HTTP)
      ↓
[2] extract dominant colors + fonts
      ↓
[3] map to semantic roles (paper, ink, muted, accent, …)
      ↓
[4] propose a style-guide.md diff
      ↓
[5] write the diff (with your approval)
      ↓
future diagrams use your tokens
```

---

## Invocation

Ask the skill:

> *"Onboard Schematic to my site — `https://example.com`"*

Or run it with an explicit URL and the skill reads this file and executes the steps below.

---

## Step 1 — fetch the page

Use `agent-browser` (preferred) or a plain `fetch`. If the site has multiple pages worth sampling (landing + blog + product), fetch 2–3 and merge the palette signals.

```bash
agent-browser navigate https://example.com --screenshot out.png --html out.html
```

---

## Step 2 — extract colors and fonts

### Colors

Parse the rendered CSS and screenshot:

- **Background color** of `<body>` or the dominant large region → `paper`
- **Primary text color** (body text) → `ink`
- **Secondary text color** (captions, meta) → `muted`
- **Most-used brand color** (CTA button, link, heading accent) → `accent`
- **Container / card background** slightly darker than paper → `paper-2`
- **Border / hairline color** → `rule` (convert to rgba of ink at ~0.12 opacity)

Prefer CSS custom properties when the site exposes them (`:root { --accent: …; }`). Otherwise pull via rendered `getComputedStyle` samples or a color-histogram pass over the screenshot.

### Fonts

Read the rendered `font-family` stack of:
- `<h1>` → `title` family
- `<body>` → `node-name` family  
- `<code>`, `<pre>`, or any mono-styled element → `sublabel` family

If the site has only one family, keep the schematic defaults for the missing roles (Instrument Serif for title, Geist Mono for mono). Don't force-pick a mono font that isn't on the site.

---

## Step 3 — map to semantic roles

Propose a diff by filling this table:

| Role | Detected | Confidence |
|---|---|---|
| paper | `#f8f6f0` | high |
| ink | `#111111` | high |
| muted | `#6b6b68` | medium |
| accent | `#c73a2b` | high |
| … | … | … |

Flag low-confidence guesses so the user can correct before applying.

### Constraint checks

Before writing, validate:

- **AA contrast**: `ink` on `paper` ≥ 4.5:1. `muted` on `paper` ≥ 4.5:1 for body text.
- **Accent is the most saturated color**: not muted-ish, not near-grey.
- **paper ≠ pure white**: if the site uses `#ffffff`, fall back to `#fafaf7` to preserve Schematic's warm-neutral feel — or ask the user to confirm pure-white is intentional.

If any check fails, propose an adjusted value and explain why.

---

## Step 4 — preview the diff

Show the user what will change in `style-guide.md`. Only the tokens table — everything else stays the same.

```diff
-| `paper`  | `#f5f4ed` | `#1c1a17` |
-| `ink`    | `#0b0d0b` | `#f1efe7` |
-| `accent` | `#f7591f` | `#ff6a30` |
+| `paper`  | `#f8f6f0` | `#1a1815` |
+| `ink`    | `#111111` | `#efeee7` |
+| `accent` | `#c73a2b` | `#e05440` |
```

Also regenerate the dark variant via the inversion rule (`rgba(11,13,11, X)` → `rgba(ink-rgb, X)`).

---

## Step 5 — apply

Write the new tokens to `style-guide.md`. Suggest running the `/regenerate-examples` flow (if it exists) or rebuilding one example to verify the new skin reads cleanly.

After onboarding, the user should:
1. Open `assets/index.html` (gallery) and confirm the new palette feels coherent across all 14 types.
2. If any type looks off, they usually need to tune `muted` (often too dark or too light against the new `paper`).

---

## When onboarding fails

- **Site uses webfonts you can't replicate** (custom-hosted, paid): keep the schematic defaults for typography and skin only the colors.
- **Brand has 6+ colors** and you can't identify a clear hierarchy: pick one as `accent`, demote the rest to `muted` variants or ignore them. The schematic grammar only uses 5–7 roles.
- **Site is dark-mode first**: flip the inversion — treat their dark paper as the default `paper`, and generate a light variant via inversion.
- **Homepage is all imagery, no text**: ask for a blog or docs URL instead — text-heavy pages expose the type hierarchy.

---

## Future: per-project skins

If the user wants multiple skins (one per project), duplicate `style-guide.md` as `style-guides/<project>.md` and add a header comment pointing the build to the active one. That's a v5.2 feature — for now, one skin per skill install.
