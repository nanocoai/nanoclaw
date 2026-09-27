# Remove Iron Proxy gateway

Select another installed gateway, then stop this copy's central proxy and official Iron Control services with:

```bash
pnpm exec tsx .claude/skills/add-iron-proxy/scripts/setup.ts --remove
```

NanoClaw's uninstall flow removes this copy's gateway material with its other data.
With the data group it also removes this copy's Iron Control containers, database
volume and network (Compose project `nanoclaw-iron-control-<slug>`), because the
encryption keys it deletes from `data/` are the only way to read that database.

The ordinary removal command above preserves Iron Control's database volume. To
keep the data, back up that volume together with
`data/session-materials/iron-control/` before uninstalling. Never remove another
copy's volume or a shared database.

Use the journal-derived skill removal to remove installed payload files.
