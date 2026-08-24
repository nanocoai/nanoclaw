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

A template is an [Agent Plugins 1.0.0](https://agent-plugins.org) directory.
Only `plugin.json` is required; it identifies the plugin and marks the folder
as a template. Any conformant plugin stamps — including a persona-less
third-party one (its skills and MCP servers load; the NanoClaw-only slots stay
empty).

```
<template>/
├── plugin.json                  # REQUIRED: Agent Plugins manifest ($schema + name)
├── mcp.json                     # optional: stdio / streamable-http MCP servers, NO secrets
├── skills/<name>/               # optional: one folder per skill (SKILL.md + references/), copied whole
├── ai.nanoco.nanoclaw/          # optional: NanoClaw extension dir
│   ├── context/
│   │   ├── instructions.md      # the agent's standing persona, prepended to its
│   │   │                        #   CLAUDE.md/AGENTS.md every spawn
│   │   └── additional_context/  # extra .md files
│   │       └── *.md
│   └── tasks/*.md               # recurring tasks, created paused
└── README.md                    # recommended: per-template docs
```

Notes:
- **Extra context is copied preserving its layout relative to `instructions.md`**
  (`ai.nanoco.nanoclaw/context/additional_context/faq.md` →
  `additional_context/faq.md` in the agent's workspace). Nothing is referenced
  automatically — `instructions.md` must point to each file (e.g. "Pricing
  rules live in `additional_context/pricing.md`").
- **No provider, no model, no packages.** A template is instructions + MCP
  servers + skills. The agent's runtime/provider is chosen separately
  (`ncl groups config update --provider …` or during setup).
- **MCP transport is declared.** Every `mcp.json` server carries a `type`:
  `"stdio"` (`command` + `args` + optional `env`) or `"streamable-http"` (an
  HTTPS `url` plus optional `headers`; plain HTTP for loopback hosts only).
  Userinfo, fragments, and credential-looking query parameters are rejected;
  other query parameters are fine. `sse` is not supported.
- **No secrets.** `mcp.json` carries launch config only; credentials are
  injected by the credentials proxy at request time. If an MCP server refuses
  to boot without an env var, use the literal `"placeholder"` — stamping
  rejects values that look like real keys.
- **No symlinks.** Stamping walks the tree and rejects symlinks and special
  files, with caps of 2,000 files / 50 MB / 16 levels.
- The whole plugin is copied to the agent group and mounted **read-only** in
  the container at `/workspace/agent/plugins/<name>`; per-plugin writable
  state lives in `plugin-data/<name>` (stdio servers get both as
  `PLUGIN_ROOT` / `PLUGIN_DATA`).
- Skills are copied into the agent's own per-group overlay, never shared.

Templates in the **pre-plugin layout** (a bare `context/instructions.md`, a
`.mcp.json`) are no longer read — stamping one fails with a migration error.
Re-fetch the template from the registry, or convert it (add `plugin.json`,
rename `.mcp.json` to `mcp.json` with the spec `$schema` + per-server `type`,
move `context/` and `tasks/` under `ai.nanoco.nanoclaw/`).

Full authoring reference: the
[registry README](https://github.com/nanocoai/nanoclaw-templates#anatomy-of-a-template)
and [docs/templates.md](../docs/templates.md).
