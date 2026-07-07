# Agent Templates

A **template** is a reusable folder you stamp into a working agent group: it
carries the agent's standing instructions, its MCP tool servers, and its skills,
but **no secrets and no provider**. Point `ncl` (or the setup wizard) at one and
you get a configured agent in seconds; you choose the runtime/provider
separately.

Templates are purely additive: no DB migration, no new dependency. **At runtime,
templates are resolved only from a local directory**: `templates/` at the
project root by default (committed but shipped empty), or whatever
`NANOCLAW_TEMPLATES_DIR` points at (a local path only). The setup wizard can also
discover templates from the public registry
([`nanocoai/nanoclaw-templates`](https://github.com/nanocoai/nanoclaw-templates))
and copy a chosen one into your local `templates/` before stamping.

## Using a template

**During install.** `bash nanoclaw.sh` opens the setup wizard. Choose **Template
setup**, then either **NanoClaw template library** (clones the public registry,
copies the template you pick into your local `templates/`) or **Local templates**
(lists what's already in `templates/`). The normal auth step then picks the
runtime, and the wizard stamps and wires your first agent.

**Anytime, via the CLI:**

```bash
ncl groups create --template sales/sdr --name "SDR Agent"
```

This stamps the group but does **not** wire it to a channel. Run
`/manage-channels` (or `ncl wirings create`) afterward, exactly as for a
hand-built group.

### The template ref

`--template <ref>` is a path **relative to the local templates directory**
(`templates/` by default, or `NANOCLAW_TEMPLATES_DIR`). Refs are multi-segment,
e.g. `sales/sdr` → `templates/sales/sdr`.

For safety the ref must stay inside the templates directory: absolute paths, a
leading `~`, and `../` escapes are rejected. There is no `--source`, no git URL,
and no remote fetch at `ncl` time. Populate `templates/` first (by hand, or via
the setup wizard's library option), then stamp.

`NANOCLAW_TEMPLATES_DIR` may point the library at another **local** directory; it
is never a URL and never changes at runtime.

## What's in a template

The full authoring reference lives in the
[templates repo README](https://github.com/nanocoai/nanoclaw-templates#anatomy-of-a-template).
The short version: only `context/instructions.md` is required; everything else
is optional and defaults sensibly:

```
<template>/
├── context/
│   ├── instructions.md        # REQUIRED: the agent's standing persona; marks the folder as a template
│   └── additional_context/    # optional: extra .md files, referenced from instructions.md by relative path
│       └── *.md
├── .mcp.json             # optional: MCP servers (command + args), NO secrets
├── skills/<name>/        # optional: one folder per skill (SKILL.md + any references/), copied whole
└── README.md             # recommended: per-template docs
```

| Path | Loaded as | Required |
|------|-----------|----------|
| `context/instructions.md` | The agent's persona, prepended to its `CLAUDE.md`/`AGENTS.md` every spawn (system-prompt tier, any provider) | **Yes** |
| `context/**/*.md` (others) | Extra context, copied into the agent's workspace with the same layout relative to `instructions.md` | No |
| `.mcp.json` → `mcpServers` | MCP tool servers (written verbatim to container config) | No |
| `skills/<name>/` | A skill, auto-triggered by its `description` | No |

Notes:

- **No provider, model, effort, or packages in a template.** Those are set on
  the agent later via `ncl groups config update`. The runtime defaults to the
  install's configured provider.
- **Keep `instructions.md` focused (under ~200 lines).** It's always in the
  agent's prompt, and some providers cap that doc (Codex ~32 KB), so an over-long
  persona gets truncated. Put bulk material in `skills/` or extra context files instead.
- Skills are copied into the agent's own skills overlay, keyed to that group,
  never shared across groups.

### Referencing extra context files

Extra `.md` files under `context/` (by convention in an `additional_context/`
subfolder) are copied into the agent's workspace preserving their position
relative to `instructions.md` — a template file at
`context/additional_context/pricing.md` is readable by the agent as
`additional_context/pricing.md`, the same relative path you'd use from
`instructions.md` itself. Nothing is injected automatically: the agent only
reads an extra file if `instructions.md` points to it, so reference every file
you ship.

```markdown
Pricing rules live in `additional_context/pricing.md`. Read it before quoting a price.
```

Context files are copied when you stamp, so files added to the template later
won't reach an already-created agent. Re-stamp the same name to update it.

## MCP servers and credentials

**Templates declare MCP servers, not secrets.** `.mcp.json` carries `command` +
`args` only:

```json
{
  "mcpServers": {
    "hubspot": { "command": "npx", "args": ["-y", "@hubspot/mcp-server"] },
    "exa":     { "command": "npx", "args": ["-y", "exa-mcp-server"] }
  }
}
```

Credentials are held by the **credentials proxy** and injected into outbound
HTTPS calls at the proxy boundary, matched by API host, at request time. The key
never sits in `.mcp.json`, the container env, or chat context. See
[the credentials proxy section in CLAUDE.md](../CLAUDE.md#secrets--credentials--onecli)
for the model.

Two ways a credential gets connected:

1. **Up front.** Register the secret with the credentials proxy (its web UI or
   CLI), matched to the service's API host (e.g. `api.example.com`). Matching
   credentials are injected automatically, so usually nothing else is needed.
2. **On demand (the common path).** Don't set anything up first. The first time
   the agent calls a service with no credential, the API returns **401/403** and
   the agent replies with a prefilled connect link for that host. The user opens
   it, pastes the key, and asks the agent to retry. The key lands in the
   credentials proxy, which injects it on every later call.

### MCP servers that require an env var to boot

Some MCP servers refuse to start unless an env var is *present*, even though the
real credential should come from the credentials proxy, not the env. Because `.mcp.json`'s `env`
block passes through verbatim to the agent's container config, put a **placeholder
value** there to satisfy the boot check:

```json
{
  "mcpServers": {
    "acme": {
      "command": "npx",
      "args": ["-y", "@acme/mcp-server"],
      "env": { "ACME_API_KEY": "placeholder" }
    }
  }
}
```

The server starts; its real outbound calls are still authenticated by the
credentials proxy. **Never put a real key in `env`**: a placeholder only, and only when
the server won't boot without one.

### Approval-gating sensitive actions

The credentials proxy can *hold* a credentialed outbound request and require a
human to approve it before it leaves the proxy: enforcement the agent can't talk
around. This is matched on the outbound HTTP request (host + method + path),
configured on the credentials proxy, and answered by NanoClaw (it DMs an approver). The host side is
already wired; see
[the credentialed-approval flow in CLAUDE.md](../CLAUDE.md#requiring-approval-for-credential-use)
and the [`sales/sdr` template README](https://github.com/nanocoai/nanoclaw-templates/blob/main/sales/sdr/README.md)
for a worked example.

## Contributing a template

Templates ship in the separate
[`nanocoai/nanoclaw-templates`](https://github.com/nanocoai/nanoclaw-templates)
repo, not this one. To add one: fork that repo, drop a folder at
`<category>/<template>/` with at least `context/instructions.md`, test it end to
end (copy it under `templates/` and run
`ncl groups create --template <category>/<template> --name Test`), confirm
no secrets are committed, and open a PR. The repo's README has the full anatomy,
category conventions, and checklist.
