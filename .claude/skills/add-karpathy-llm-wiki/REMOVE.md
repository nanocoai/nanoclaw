# Remove Karpathy LLM Wiki

Every step is idempotent — safe to re-run.

## 1. Remove the shared container skill

The wiki container skill lives in the shared `container/skills/` mount, which is auto-discovered and symlinked into every agent group. Delete it so it stops appearing in all containers:

```bash
rm -rf container/skills/wiki
```

## 2. Remove the wiki section from the group CLAUDE.md

The wiki section is wrapped in marker comments. Delete the block (markers included) from the group's CLAUDE.md — find it under `groups/<folder>/CLAUDE.md`:

```bash
# Replace <folder> with the group folder you set up the wiki for.
perl -0pi -e 's/\n?<!-- BEGIN karpathy-llm-wiki -->.*?<!-- END karpathy-llm-wiki -->\n?//s' groups/<folder>/CLAUDE.md
```

If the markers are absent, nothing is removed (the block was already gone or never added).

## 3. Restart so containers drop the skill

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```

## User content is preserved

The per-group `groups/<folder>/wiki/` and `groups/<folder>/sources/` directories hold the user's own knowledge base and ingested sources. They are left in place. Delete them by hand only if the user explicitly wants their wiki content gone:

```bash
rm -rf groups/<folder>/wiki groups/<folder>/sources
```
