---
name: list-marketplaces
description: List the plugin marketplaces registered for a NanoClaw agent group. Operator-side; mirrors `claude plugin marketplace list` but scoped to one group's container.json. Triggers on "list marketplaces", "show marketplaces", "what marketplaces".
---

# /list-marketplaces

Show the plugin marketplaces registered in `groups/<folder>/container.json:plugins.marketplaces`.

## Run

```bash
pnpm exec tsx scripts/list-marketplaces.ts <group-folder>
```

The script prints JSON. Format it as a readable table for the operator: name, source type, key fields (repo/url/path).

## Empty result

If the JSON is `{}`, no marketplaces are registered for this group. Suggest `/add-marketplace` if the operator wanted plugins available.

## See also

- `/add-marketplace` — register a marketplace
- `/list-plugins` — show enabled plugins (which require a registered marketplace)
