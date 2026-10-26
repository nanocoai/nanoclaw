---
name: uninstall-plugin
description: Disable a Claude Code plugin in a NanoClaw agent group. Operator-side; mirrors `claude plugin uninstall`. The marketplace registration stays so other plugins from it remain installable. Triggers on "uninstall plugin", "disable plugin", "remove plugin from group".
---

# /uninstall-plugin

Disable a plugin from `groups/<folder>/container.json:plugins.enabled`.

## Run

```bash
pnpm exec tsx scripts/uninstall-plugin.ts <group-folder> <plugin>@<marketplace>
```

The script removes the entry, restarts the group's containers, and the SDK won't load that plugin on next start.

## What stays

The marketplace registration in `plugins.marketplaces` is untouched — other plugins from the same marketplace can still be enabled. To unregister the marketplace itself, use `/remove-marketplace` (which refuses if any plugin from it is still enabled).

## NanoClaw doesn't distinguish "disabled" from "uninstalled"

In Claude Code's CLI, `disable` keeps the plugin's cache files; `uninstall` removes them. NanoClaw's SDK-driven model has no separate per-group cache state — the only switch is `plugins.enabled`. So `/uninstall-plugin` is the universal "stop loading this plugin" verb.

## Verification

```bash
pnpm exec tsx scripts/list-plugins.ts <group-folder>
```

The plugin should no longer be in the output. Send a message; the agent's `init` event should no longer list it.
