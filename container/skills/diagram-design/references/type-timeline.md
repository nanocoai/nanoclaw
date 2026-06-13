# Timeline

**Best for:** release history, project milestones, incident timelines, roadmaps, changelog visualizations.

## Layout conventions
- Horizontal hairline baseline across the middle (`stroke-width=1`).
- Tick marks at time boundaries (quarters, months, sprints) with date labels below in Geist Mono.
- Events: small filled circles (`r=4`) on the baseline. Labels alternate above and below to prevent collision, connected to the circle with a 1px hairline drop.
- Major milestones: coral circle (`r=6`) + bold Geist label.
- Time scale must be honest: if intervals are non-equal, space the circles non-equally. Don't fake linear spacing for aesthetics. Break the axis visibly if a region is too dense.

## Anti-patterns
- Equal-spacing events that aren't equally spaced in time.
- Missing axis labels ("what unit is this?").
- Crowded labels without vertical offset — illegible.

## Examples
- `assets/example-timeline.html` — minimal light
- `assets/example-timeline-dark.html` — minimal dark
- `assets/example-timeline-full.html` — full editorial
