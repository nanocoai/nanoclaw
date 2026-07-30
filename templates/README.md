# Templates

Local agent-template library for this NanoClaw install. **This folder ships
empty.** Anything you drop here is a template you can stamp into an agent:

```bash
ncl groups create --template <relative-ref> --name "My Agent"
```

`<relative-ref>` is a path *relative to this folder* (e.g. `sales/sdr`). Refs
must stay inside this directory — absolute paths, `~`, and `../` escapes are
rejected. Override the location with `NANOCLAW_TEMPLATES_DIR=/another/local/path`
(a local path only — never a URL).

To use a template from the public registry
([`nanocoai/nanoclaw-templates`](https://github.com/nanocoai/nanoclaw-templates)),
clone or download it yourself and copy the chosen template *into this folder*,
then stamp from the local copy. There is no remote fetch — templates are only
ever resolved from here.

## Anatomy of a template

Only `context/instructions.md` is required; it both supplies the agent's
standing brief and marks the folder as a template.

```
<template>/
├── context/
│   ├── instructions.md        # REQUIRED: the agent's standing persona, prepended to its
│   │                          #           CLAUDE.md/AGENTS.md every spawn
│   └── additional_context/    # optional: extra .md files
│       └── *.md
├── .mcp.json             # optional: { "mcpServers": { ... } } — command + args, NO secrets
├── skills/<name>/        # optional: one folder per skill (SKILL.md + references/), copied whole
└── README.md             # recommended: per-template docs
```

Notes:
- **Extra context is copied preserving its layout relative to `instructions.md`**
  (`context/additional_context/faq.md` → `additional_context/faq.md` in the
  agent's workspace). Nothing is referenced automatically — `instructions.md`
  must point to each file (e.g. "Pricing rules live in
  `additional_context/pricing.md`").
- **No provider, no model, no packages.** A template is instructions + MCP
  servers + skills. The agent's runtime/provider is chosen separately
  (`ncl groups config update --provider …` or during setup).
- **No secrets.** `.mcp.json` carries launch config only; credentials are
  injected by the credentials proxy at request time. If an MCP server refuses
  to boot without an env var, use a placeholder value — never a real key.
- Skills are copied into the agent's own per-group overlay, never shared.
