# Remove Google Drive Tool

Idempotent — safe to run even if some steps were never applied.

## 1. Remove the skill from any group that pinned an explicit skill list

Only needed for groups whose `container.json` `skills` field is an explicit
array rather than `'all'` (see `add-gdrive-tool/SKILL.md` Phase 3). For each
such group, drop `"gdrive-fetch"` from the array and restart:

```bash
ncl groups restart --id <group-id>
```

Groups on the default `skills: 'all'` don't need this — `gdrive-fetch` simply
stops applying once the trunk directory is deleted (step 3).

## 2. Revoke the OneCLI connection (optional)

Only if no other tool on this install needs Drive access:

```bash
onecli apps disconnect --provider google-drive
```

## 3. Delete the container skill (optional — only if removing entirely)

```bash
rm -rf container/skills/gdrive-fetch
```

No Docker rebuild needed — `container/skills/` is a read-only bind mount, not
baked into the image.
