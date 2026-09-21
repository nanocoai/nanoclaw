# Remove AnyDoc

Every step is safe to re-run. Remove only files and configuration installed by `/add-anydoc`.

Before removing anything, inspect per-group image pins. Standard NanoClaw derived images can be rebuilt without AnyDoc. Stop and report any other pin because its owner must decide how to rebuild it:

```bash
if [ -f data/v2.db ]; then
  source setup/lib/install-slug.sh
  image_base="$(container_image_base)"
  foreign=0
  while IFS='|' read -r group_id image_tag package_count; do
    [ -z "$group_id" ] && continue
    if [ "$image_tag" != "${image_base}:${group_id}" ]; then
      echo "Foreign image pin: $group_id -> $image_tag" >&2
      foreign=1
    elif [ "$package_count" -eq 0 ]; then
      echo "Derived image cannot be rebuilt: $group_id has no configured packages" >&2
      foreign=1
    elif ! ncl groups get --id "$group_id" >/dev/null; then
      echo "Cannot reach NanoClaw through ncl for derived image: $group_id" >&2
      foreign=1
    fi
  done < <(pnpm exec tsx scripts/q.ts data/v2.db \
    "SELECT agent_group_id, image_tag, COALESCE(json_array_length(packages_apt), 0) + COALESCE(json_array_length(packages_npm), 0) FROM container_configs WHERE image_tag IS NOT NULL ORDER BY agent_group_id")
  [ "$foreign" -eq 0 ]
fi
```

## 1. Remove the container skill and guard

```bash
rm -rf container/skills/convert-documents-to-markdown
rm -f src/anydoc-manifest.test.ts
```

## 2. Remove the CLI manifest entry

Remove only `@firecrawl/anydoc`, preserving every other tool:

```bash
node -e '
  const fs = require("node:fs");
  const file = "container/cli-tools.json";
  const tools = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(tools)) throw new Error(file + " must contain a JSON array");
  fs.writeFileSync(
    file,
    JSON.stringify(tools.filter((tool) => tool?.name !== "@firecrawl/anydoc"), null, 2) + "\n",
  );
'
```

## 3. Validate and rebuild

On a hardened-image install, pull the clean published base first so the new overlay does not inherit AnyDoc from the previous overlay. Then rebuild from the remaining CLI manifest:

```bash
set -e
pnpm exec vitest run container/cli-tools.test.ts
pnpm run build

hardened="${NANOCLAW_HARDENED_IMAGE:-}"
if [ -z "$hardened" ] && [ -f .env ]; then
  hardened="$(grep '^NANOCLAW_HARDENED_IMAGE=' .env | tail -n1 | cut -d= -f2-)"
fi
hardened="$(printf '%s' "$hardened" | tr -d '"' | tr -d "'" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
if [ "$hardened" = "true" ]; then
  ./container/build.sh pull
fi
./container/build.sh

source setup/lib/install-slug.sh
image="$(container_image_base):latest"
docker run --rm --entrypoint sh "$image" -c \
  'if command -v anydoc; then echo "AnyDoc is still present" >&2; exit 1; fi'

if [ -f data/v2.db ]; then
  image_base="$(container_image_base)"
  while IFS='|' read -r group_id image_tag; do
    [ -z "$group_id" ] && continue
    if [ "$image_tag" != "${image_base}:${group_id}" ]; then
      echo "Foreign image pin appeared during removal: $group_id -> $image_tag" >&2
      exit 1
    fi
    ncl groups restart --id "$group_id" --rebuild
    docker run --rm --entrypoint sh "$image_tag" -c \
      'if command -v anydoc; then echo "AnyDoc is still present" >&2; exit 1; fi'
  done < <(pnpm exec tsx scripts/q.ts data/v2.db \
    "SELECT agent_group_id, image_tag FROM container_configs WHERE image_tag IS NOT NULL ORDER BY agent_group_id")
fi
```

## 4. Restart

Restart this NanoClaw service only so running containers stop and the skill disappears on their next spawn:

```bash
source setup/lib/install-slug.sh
# macOS
launchctl kickstart -k "gui/$(id -u)/$(launchd_label)"
# Linux
systemctl --user restart "$(systemd_unit)"
```

Run only the command for the current platform. If NanoClaw is not service-managed, stop this install's running agent containers by their `nanoclaw-install=<install-slug>` label.

Do not delete `/workspace/agent/converted/` or other converted Markdown. Those files are user data.
