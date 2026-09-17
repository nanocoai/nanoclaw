---
name: remove-marketplace
description: Unregister a Claude Code plugin marketplace from a NanoClaw agent group. Refuses if any plugin from the marketplace is still enabled. Triggers on "remove marketplace", "unregister marketplace", "delete marketplace".
---

# /remove-marketplace

Unregister a marketplace from `groups/<folder>/container.json:plugins.marketplaces`. Mirrors `claude plugin marketplace remove`.

## Safety

If any plugin in `plugins.enabled` references the marketplace (i.e., its key ends with `@<marketplace-name>`), the operation is refused. Run `/uninstall-plugin <plugin-spec>` for each referencing plugin first, then retry.

## Run

```bash
pnpm exec tsx scripts/remove-marketplace.ts <group-folder> <name>
```

The script validates references, removes the entry from `container.json`, and restarts the group's containers.

## Note on SDK self-state

The SDK keeps its own marketplace cache at `~/.claude/plugins/marketplaces/<name>/` (per session-shared dir), tracked in `known_marketplaces.json`. NanoClaw doesn't touch that — removing the `extraKnownMarketplaces` entry just stops the SDK from loading from there on next start. The cached clone is harmless and gets overwritten if the marketplace is re-registered.

## Verification

```bash
pnpm exec tsx scripts/list-marketplaces.ts <group-folder>
```

The removed entry should be absent.
