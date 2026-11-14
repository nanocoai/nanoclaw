---
name: add-marketplace
description: Register a Claude Code plugin marketplace for a NanoClaw agent group. Operator-side; mirrors `claude plugin marketplace add` but writes to a per-group container.json. Triggers on "add marketplace", "register marketplace", "plugin marketplace".
---

# /add-marketplace

Register a plugin marketplace in `groups/<folder>/container.json:plugins.marketplaces` so the agent's SDK loads plugins from it on next session start. Mirrors Claude Code's `claude plugin marketplace add` but scoped to one NanoClaw agent group.

## Inputs

Ask the operator (if not already provided):

1. **Group folder** — the agent group to configure. List groups with `pnpm exec tsx scripts/q.ts data/v2.db "SELECT folder, name FROM agent_groups"` if the operator doesn't know.
2. **Marketplace name** — a label for the marketplace within this group. Avoid spaces, slashes, dots-only.
3. **Source** — one of the eight `extraKnownMarketplaces` source variants (see `src/container-config.ts:ExtraKnownMarketplaceSource`):
   - `github` — `{ "source": "github", "repo": "owner/repo", "ref": "main" }`
   - `git`    — `{ "source": "git",    "url": "https://...", "ref": "..." }`
   - `url`    — `{ "source": "url",    "url": "https://example.com/marketplace.json", "headers": {...} }`
   - `npm`    — `{ "source": "npm",    "package": "..." }`
   - `file`   — `{ "source": "file",   "path": "/abs/path/marketplace.json" }`
   - `directory` — `{ "source": "directory", "path": "/abs/path/" }`

## Run

```bash
pnpm exec tsx scripts/add-marketplace.ts <group-folder> <name> '<source-json>'
```

The script validates the source schema, idempotently writes `container.json:plugins.marketplaces[<name>]`, and restarts the group's containers (so the next message picks up the new marketplace).

## Private repos

If the source points at a private github repo, run `/setup-private-plugins` once on this host first (registers the github PAT in OneCLI vault). Without it, the SDK's clone at session init will fail with a visible `plugin_install:failed` event but the session continues without the marketplace's plugins.

## Verification

After running:

```bash
pnpm exec tsx scripts/list-marketplaces.ts <group-folder>
```

The new entry should be present. Send a message to the group; the agent's `init` event will list the loaded plugins (after the SDK clones the marketplace).
