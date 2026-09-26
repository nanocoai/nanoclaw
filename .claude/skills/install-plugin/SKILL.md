---
name: install-plugin
description: Enable a Claude Code plugin in a NanoClaw agent group. Operator-side; mirrors `claude plugin install` but writes to a per-group container.json. Supports `--source` for one-shot register-and-install. Triggers on "install plugin", "enable plugin", "add plugin to group".
---

# /install-plugin

Enable a plugin in `groups/<folder>/container.json:plugins.enabled`. The plugin's marketplace must already be registered (see `/add-marketplace`), or supply a `--source` to register it inline.

## Inputs

Ask the operator (if not already provided):

1. **Group folder** — the agent group to configure.
2. **Plugin spec** — `<plugin-name>@<marketplace-name>` (the format the SDK uses in `enabledPlugins`).
3. **Optional `--source`** — JSON for `extraKnownMarketplaces` if the marketplace isn't yet registered. See `/add-marketplace` for the schema.

## Run (marketplace already registered)

```bash
pnpm exec tsx scripts/install-plugin.ts <group-folder> <plugin>@<marketplace>
```

## Run (one-shot register + install)

```bash
pnpm exec tsx scripts/install-plugin.ts <group-folder> <plugin>@<marketplace> \
  --source '{"source":"github","repo":"owner/repo","ref":"main"}'
```

The script writes both `marketplaces[<name>]` and `enabled[<spec>]=true` in a single locked update, then restarts the group. Single-restart semantics — no half-state window.

## On disable / enable distinction

Claude Code's CLI distinguishes "plugin installed but disabled" from "plugin uninstalled" because of its own cache management. **NanoClaw's SDK-driven model has no separate cache state per group** — there's just `plugins.enabled`. `/install-plugin` and `/uninstall-plugin` are the only switches. If documentation tells you to `claude plugin disable`, use `/uninstall-plugin` here.

## Private repos

If the source is a private github repo:

1. Run `/setup-private-plugins` once on this host (registers a github PAT in OneCLI vault with `Authorization: Basic` injection for `github.com`).
2. Then `/install-plugin` proceeds normally; the SDK clones via the OneCLI gateway with auth injected at the proxy layer.

If the OneCLI entry isn't configured, this skill prints a warning and continues; the SDK clone will fail at session init with a visible `plugin_install:failed` event but the session continues without the plugin.

## Verification

```bash
pnpm exec tsx scripts/list-plugins.ts <group-folder>
```

The new entry should be present. Send a message to the group; the agent's `init` event lists loaded plugins (after the SDK installs the marketplace+plugin).
