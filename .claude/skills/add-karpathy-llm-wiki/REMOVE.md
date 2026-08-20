# Remove Karpathy LLM Wiki

Every step is idempotent — safe to re-run.

Resolve the two values the wiki was installed against, and use them throughout:

```bash
GROUP_ID=<ag-...>        # agent group id
GROUP_FOLDER=<folder>    # the group's folder under groups/
```

`ncl groups list` prints both. If `ncl` cannot reach the host, read them with the in-tree query wrapper:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, name, folder FROM agent_groups ORDER BY name"
```

## 1. Cancel the lint schedule

Find the wiki lint series and delete it, otherwise it keeps firing forever:

```bash
ncl tasks list --group "$GROUP_ID"
ncl tasks delete --id <series-id>
```

## 2. Remove the wiki section from the standing instructions

```bash
perl -0pi -e 's/\n?<!-- BEGIN karpathy-llm-wiki -->.*?<!-- END karpathy-llm-wiki -->\n?//s' \
  "groups/$GROUP_FOLDER/instructions.prepend.md"
```

Read the file afterwards. When the wiki section was its only content, delete the now-empty file so the composer stops emitting a persona fragment for it:

```bash
[ -s "groups/$GROUP_FOLDER/instructions.prepend.md" ] || rm -f "groups/$GROUP_FOLDER/instructions.prepend.md"
```

Also delete the wiki pointer line from `groups/$GROUP_FOLDER/memory/index.md` — the line referencing `wiki/index.md` — and leave the rest of that file alone.

## 3. Remove the per-group wiki skill

```bash
rm -rf "data/v2-sessions/$GROUP_ID/.claude-shared/skills/wiki"
```

## 4. Remove the delivery-seam guard

```bash
rm -f src/wiki-delivery-seam.test.ts
```

## 5. Restart so the group drops the wiki context

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k "gui/$(id -u)/$(launchd_label)"  # macOS
systemctl --user restart "$(systemd_unit)"              # Linux
```

Run only the command for the current platform. If NanoClaw is not service-managed, stop this install's running agent containers by their `nanoclaw-install=<install-slug>` label instead.

## User content is preserved

`groups/$GROUP_FOLDER/wiki/` and `groups/$GROUP_FOLDER/sources/` hold the user's own knowledge base and ingested sources, and stay in place. Delete them only when the user explicitly asks for their wiki content gone:

```bash
rm -rf "groups/$GROUP_FOLDER/wiki" "groups/$GROUP_FOLDER/sources"
```

A group created solely for the wiki also stays. Removing it is a separate decision the user makes:

```bash
ncl groups delete --id "$GROUP_ID"
```
