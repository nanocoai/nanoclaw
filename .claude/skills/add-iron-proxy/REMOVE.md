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

A console image that setup built on this machine (`nanoclaw-iron-control:<revision>-<arch>`,
only on engines that cannot run the amd64 image) carries no install label: it is
shared by every copy on the machine, so neither this command nor `nanoclaw uninstall`
removes it, and a new pinned revision leaves the old one behind. Prune it yourself
once no copy needs it: `docker rmi nanoclaw-iron-control:<revision>-<arch>` (list them
with `docker images nanoclaw-iron-control`).
