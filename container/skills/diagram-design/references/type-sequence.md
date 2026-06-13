# Sequence

**Best for:** request/response flows, protocol exchanges, multi-actor interactions over time, API call traces, incident reconstructions.

## Layout conventions
- Actors as boxes in a horizontal row at the top.
- **Lifelines**: dashed vertical lines descending from each actor to the bottom.
- Messages: horizontal arrows between lifelines; time flows top→down.
- **Activation bar**: narrow rectangle (`w=8`, muted fill, 0.8 hairline stroke) on a lifeline spanning the interval that actor holds control. Stack for nested calls.
- Self-messages: short U-shaped loop returning to the same lifeline; label right of the loop.
- Return messages: dashed line in the same color as the originating call.
- Coral on the primary success response or headline message — one, maybe two.

## Anti-patterns
- Message arrow pointing *upward* (reverses time — never).
- Activation bars that never close.
- Labels sitting over another lifeline — shorten or shift y into a gap.
- Swimlane-style lanes instead of lifelines (different grammar).

## Lifeline primitive
```svg
<line x1="CX" y1="TOP" x2="CX" y2="BOTTOM"
      stroke="rgba(45,49,66,0.20)" stroke-width="1" stroke-dasharray="3,3"/>
```

## Activation bar primitive
```svg
<rect x="CX-4" y="TOP" width="8" height="H"
      fill="rgba(45,49,66,0.06)" stroke="#4f5d75" stroke-width="0.8"/>
```

## Examples
- `assets/example-sequence.html` — minimal light
- `assets/example-sequence-dark.html` — minimal dark
- `assets/example-sequence-full.html` — full editorial
