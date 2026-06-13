# Layer Stack

**Best for:** OSI model, CSS cascade, context hierarchy, tech stack, abstraction layers, memory hierarchy.

## Layout conventions
- Horizontal bands stacked vertically. Each layer is a full-width rectangle (same x, same width). 4–6 layers total.
- Layer height 56–72px, width typically 800–880px inside a 1000px viewBox.
- Each row contains (left→right):
  1. **Index tag** on the far left (`L3`, `07`, `APPLICATION`) — Geist Mono 8–9px eyebrow.
  2. **Layer name** slightly right of center-left — Geist 14–16px 600.
  3. **Sublabel / note** on the far right — Geist Mono 9–10px muted.
- Border between layers: 1px hairline `rgba(45,49,66,0.12)`. Outer silhouette 1px ink or muted.
- Fills: either alternating subtle shades (paper / paper-2) OR all paper with hairline dividers. Pick one and hold it.
- Direction indicator on the LEFT margin (outside the stack): small up/down arrow + Geist Mono label (`abstraction ↑`, `packets ↓`).
- Coral on **one** focal layer (stroke + subtle tint fill) — the bottleneck, the pay-rent layer, the one under discussion.

## Anti-patterns
- Layers that aren't actually hierarchical (use swimlane or architecture).
- Skipped numbering (missing L4 between L3 and L5 without explanation).
- Every layer a different color — hierarchy invisible.
- Inconsistent layer heights without reason.

## Examples
- `assets/example-layers.html` — minimal light
- `assets/example-layers-dark.html` — minimal dark
- `assets/example-layers-full.html` — full editorial
