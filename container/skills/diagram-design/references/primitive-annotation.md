# Annotation Callout (italic-serif aside)

Use for editorial asides — the "italic pointer" that marks a detail without competing with the primary diagram grammar. Think marginalia: *"structure IS the index"*, *"no imports, no configuration"*.

## Grammar

```svg
<!-- 1. Italic Instrument Serif text -->
<text x="904" y="36" fill="#2d3142" font-size="14" font-style="italic"
      font-family="'Instrument Serif', serif" text-anchor="end">no imports, no configuration</text>
<!-- 2. Dashed Bézier leader -->
<path d="M 820 44 Q 700 84 520 216" fill="none"
      stroke="rgba(45,49,66,0.40)" stroke-width="1" stroke-dasharray="4,3"/>
<!-- 3. Landing dot -->
<circle cx="520" cy="216" r="2" fill="#2d3142"/>
```

## Rules
- Italic + serif together signal "editorial voice" against the diagram's sans/mono body. Don't substitute italic sans or italic mono — the combination is load-bearing.
- Dashed path (`stroke-dasharray="4,3"`) distinguishes the callout leader from primary arrows (which are solid).
- Place callouts in margins (top-right, bottom-left). Never inside the active diagram area.
- Max 2 callouts per diagram. More becomes commentary, not signal.

## Colors

| Intent | Text | Leader |
|---|---|---|
| Neutral aside | ink `#2d3142` | `rgba(45,49,66,0.40)` |
| Focal / accent | coral `#eb6c36` | `rgba(235,108,54,0.50)` |
| Tertiary (muted) | muted `#4f5d75` | `rgba(45,49,66,0.30)` |

## Anti-patterns
- Solid arrow leader (reads as a flow arrow).
- Italic sans or italic mono — the serif is load-bearing.
- Callouts crossing primary arrows / lifelines — offset to a clear margin.
- Using a callout to label something the diagram should label directly — put the label on the element.
