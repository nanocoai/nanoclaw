# Remove Iron Proxy gateway

Select another installed gateway, then stop this copy's central proxy and official Iron Control services with:

```bash
pnpm exec tsx .claude/skills/add-iron-proxy/scripts/setup.ts --remove
```

NanoClaw's uninstall flow removes this copy's gateway material with its other data.
Iron Control's `web` and `database` containers carry the same `nanoclaw-install`
and `nanoclaw-role=gateway` labels as the central proxy. A container with the
install label, the gateway role (`nanoclaw-role=gateway`) and no session label
is gateway-owned (`GATEWAY_ROLE`, see `docs/gateway-seam.md`): the update drain
and the host's residue reaping leave it alone. The
uninstaller does not read the role: it takes the Compose project of each
container with this copy's install label, which is this copy's alone because the
project name comes from the install slug. With the data group it then
removes the project's containers, database volume and network, because the
encryption keys it deletes from `data/` are the only way to read that database. The project is found through
its containers: an install whose containers predate the labels gets them on its
next setup run, and a volume whose containers were already removed (the command
above, or an earlier service-only uninstall) is not found. In both cases the
uninstaller leaves the volume and the next setup prints the exact removal commands.

The ordinary removal command above preserves Iron Control's database volume. To
keep the data, back up that volume together with
`data/session-materials/iron-control/` before uninstalling. Never remove another
copy's volume or a shared database.

Use the journal-derived skill removal to remove installed payload files.
