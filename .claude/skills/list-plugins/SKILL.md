---
name: list-plugins
description: List the Claude Code plugins enabled for a NanoClaw agent group. Operator-side; mirrors `claude plugin list` but scoped to one group. Triggers on "list plugins", "show plugins", "what plugins".
---

# /list-plugins

Show the plugins enabled in `groups/<folder>/container.json:plugins.enabled`.

## Run

```bash
pnpm exec tsx scripts/list-plugins.ts <group-folder>
```

The script prints JSON. Format readably for the operator: each entry as `<plugin>@<marketplace>: <state>` (state = `true` for plain enable, version-array for version-pinned, or object for advanced enable).

## See also

- `/install-plugin` — enable a plugin
- `/uninstall-plugin` — disable
- `/list-marketplaces` — show registered marketplaces (which plugins reference by `@<name>`)
