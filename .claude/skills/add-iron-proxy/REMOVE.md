# Remove Iron Proxy gateway

Select another installed gateway, then stop this copy's central proxy and official Iron Control services with:

```bash
pnpm exec tsx .claude/skills/add-iron-proxy/scripts/setup.ts --remove
```

NanoClaw's uninstall flow removes this copy's gateway material with its other data.

The ordinary removal command preserves Iron Control's database volume. Before
uninstalling this copy, either back up that volume together with
`data/session-materials/iron-control/`, or remove the database with the exact
Compose project/file printed by setup using `docker compose ... down --volumes`
when the operator requested permanent data deletion. Do this before NanoClaw
removes the encryption keys. Never remove another copy's volume or a shared
database.

Use the journal-derived skill removal to remove installed payload files.
