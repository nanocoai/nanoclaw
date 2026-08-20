# Remove rtk

Idempotent — safe to run even if some steps were never applied. Run step 1 and step 2 once per agent group that has the hook (`ncl groups list`), then steps 3-6 once.

## 1. Remove the PreToolUse hook from the group's settings

Delete the rtk Bash hook entry. This leaves any other `PreToolUse` entries intact and is safe to re-run:

```bash
SETTINGS="data/v2-sessions/<group-id>/.claude-shared/settings.json"

jq '.hooks.PreToolUse = ((.hooks.PreToolUse // [])
      | map(select((.hooks // []) | any(.command == "rtk hook claude") | not)))' \
  "$SETTINGS" > /tmp/rtk-settings.json && mv /tmp/rtk-settings.json "$SETTINGS"
```

## 2. Restart the group's containers

```bash
ncl groups restart --id <group-id>
```

## 3. Remove the manifest entry

```bash
jq 'map(select(.name != "rtk"))' container/cli-tools.json > /tmp/rtk-cli-tools.json \
  && mv /tmp/rtk-cli-tools.json container/cli-tools.json
pnpm exec vitest run container/cli-tools.test.ts
```

## 4. Remove the guard test

```bash
rm -f src/rtk-manifest.test.ts
```

## 5. Take rtk out of the image

The binary is baked into the image, so dropping the manifest entry alone does not remove it. Which command rebuilds without it depends on how this install gets its image:

```bash
grep -E '^NANOCLAW_HARDENED_IMAGE=[\"'\'']?true' .env >/dev/null 2>&1 && echo PULLS || echo BUILDS
```

- `BUILDS` — `./container/build.sh` rebuilds the image from the Dockerfile, now without the rtk entry.
- `PULLS` — `./container/build.sh pull` re-fetches the published image, discarding the local overlay layer that added rtk. A bare `./container/build.sh` would layer over the image that already has rtk in it and leave the binary in place.

Then confirm it is gone:

```bash
source setup/lib/install-slug.sh
docker run --rm --entrypoint sh "$(container_image_base):latest" -c 'command -v rtk || echo REMOVED'
```

## 6. Rebuild derived group images

Groups pinned to their own derived image keep rtk until that image is rebuilt from the new shared one:

```bash
if [ -f data/v2.db ]; then
  while IFS='|' read -r group_id image_tag; do
    [ -n "$group_id" ] || continue
    echo "Rebuilding derived image for $group_id ($image_tag)"
    ncl groups restart --id "$group_id" --rebuild
  done < <(pnpm exec tsx scripts/q.ts data/v2.db \
    "SELECT agent_group_id, image_tag FROM container_configs WHERE image_tag IS NOT NULL ORDER BY agent_group_id")
fi
```
