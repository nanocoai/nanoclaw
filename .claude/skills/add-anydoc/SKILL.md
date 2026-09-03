---
name: add-anydoc
description: Add local office-document-to-Markdown conversion to NanoClaw agent containers with the pinned Firecrawl AnyDoc CLI. Use when agents need to read attached Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, or text-based PDF files without uploading them to a hosted parser.
---

# Add AnyDoc

Install one pinned CLI and one focused container skill. Keep document conversion inside the agent container; do not change NanoClaw's attachment pipeline or add credentials, an MCP server, or a hosted parser.

## Preflight

1. Read `CONTRIBUTING.md`, `docs/skill-guidelines.md`, and the supply-chain section of `docs/SECURITY.md`.
2. Run this check against the official npm registry before changing files:

   ```bash
   curl -fsSL "https://registry.npmjs.org/@firecrawl%2Fanydoc" | node -e '
     let body = "";
     process.stdin.setEncoding("utf8");
     process.stdin.on("data", (chunk) => (body += chunk));
     process.stdin.on("end", () => {
       const metadata = JSON.parse(body);
       const version = "0.1.6";
       const release = metadata.versions?.[version];
       const publishedAt = Date.parse(metadata.time?.[version] ?? "");
       const eligibleAt = publishedAt + 72 * 60 * 60 * 1000;
       if (!release) throw new Error(`${version} is missing from the registry`);
       if (release.deprecated) throw new Error(`${version} is deprecated: ${release.deprecated}`);
       if (!Number.isFinite(publishedAt)) throw new Error(`missing publish time for ${version}`);
       if (Date.now() < eligibleAt) throw new Error(`${version} is gated until ${new Date(eligibleAt).toISOString()}`);
       console.log(`${version} passed the 72-hour release gate`);
     });
   '
   ```

   Stop on any failure. Do not install a PR commit, add a `minimumReleaseAgeExclude`, enable lifecycle scripts, or silently substitute another version, unless the user explicitly approves it.

3. Inspect `container/cli-tools.json` for `@firecrawl/anydoc` before changing files:
   - No entry: continue.
   - Exactly one entry at `0.1.6`: leave it unchanged.
   - A duplicate or any other version: stop and report the conflict.
4. Check whether `container/skills/convert-documents-to-markdown/SKILL.md` and `src/anydoc-manifest.test.ts` already exist. Reapplying this skill overwrites only those dedicated files.
5. If `data/v2.db` exists, inspect per-group image pins before changing files. Standard derived images can be rebuilt from the updated shared image. Stop and report any other pin because its owner must decide how to rebuild it:

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

## Install

Resolve this skill's bundled files from either Claude Code's skill variable or the project skill directory, then copy both files:

```bash
project_root="$(git rev-parse --show-toplevel)"
skill_dir="${CLAUDE_SKILL_DIR:-$project_root/.claude/skills/add-anydoc}"
test -f "$skill_dir/container-skills/convert-documents-to-markdown/SKILL.md"
test -f "$skill_dir/anydoc-manifest.test.ts"
mkdir -p container/skills/convert-documents-to-markdown
cp "$skill_dir/container-skills/convert-documents-to-markdown/SKILL.md" \
  container/skills/convert-documents-to-markdown/SKILL.md
cp "$skill_dir/anydoc-manifest.test.ts" src/anydoc-manifest.test.ts
```

If the manifest has no AnyDoc entry, append this exact object to its JSON array. Do not add `onlyBuilt`; the package and its prebuilt Linux bindings have no install lifecycle script.

```json
{ "name": "@firecrawl/anydoc", "version": "0.1.6" }
```

## Validate and build

Run validation before building the image:

```bash
pnpm exec vitest run src/anydoc-manifest.test.ts container/cli-tools.test.ts
pnpm run build
./container/build.sh
```

If pnpm rejects the package as too new, stop. Do not bypass the release-age policy.

Rebuild standard per-group images so groups with custom packages inherit the updated shared image:

```bash
if [ -f data/v2.db ]; then
  source setup/lib/install-slug.sh
  image_base="$(container_image_base)"
  while IFS='|' read -r group_id image_tag; do
    [ -z "$group_id" ] && continue
    if [ "$image_tag" != "${image_base}:${group_id}" ]; then
      echo "Foreign image pin appeared during install: $group_id -> $image_tag" >&2
      exit 1
    fi
    ncl groups restart --id "$group_id" --rebuild
  done < <(pnpm exec tsx scripts/q.ts data/v2.db \
    "SELECT agent_group_id, image_tag FROM container_configs WHERE image_tag IS NOT NULL ORDER BY agent_group_id")
fi
```

Resolve this install's image name and exercise the native binding, not only the help path:

```bash
source setup/lib/install-slug.sh
image="$(container_image_base):latest"
docker run --rm --entrypoint anydoc "$image" --version
printf 'name,count\nalpha,2\n' | \
  docker run --rm -i --entrypoint anydoc "$image" - --format csv | grep -q alpha
docker run --rm --entrypoint sh "$image" -c 'command -v timeout'
```

If `timeout` is absent, remove its wrapper from the installed container skill; do not add another dependency. Convert local DOCX, PPTX, and XLSX fixtures when available. Do not add private or large binary fixtures to the repository.

## Restart

Restart this NanoClaw service only, so its running containers stop and default `skills: "all"` groups receive the new shared skill on their next spawn:

```bash
source setup/lib/install-slug.sh
# macOS
launchctl kickstart -k "gui/$(id -u)/$(launchd_label)"
# Linux
systemctl --user restart "$(systemd_unit)"
```

Run only the command for the current platform. If NanoClaw is not service-managed, stop this install's running agent containers by their `nanoclaw-install=<install-slug>` label instead of matching every `nanoclaw-v2` container on the host.

## Smoke test

Use one real channel attachment and verify the complete path:

1. Confirm the message supplies an absolute local path such as `/workspace/inbox/<message-id>/<file>`, and use that exact path.
2. Convert it to `/workspace/agent/converted/` and summarize only the relevant Markdown sections.
3. Confirm an image-only PDF fails clearly and is not uploaded anywhere.
4. For agents open to unknown senders, recommend an operator-set `CONTAINER_MEMORY_LIMIT`; AnyDoc's parser caps decompression, but NanoClaw containers have no memory limit by default.

Report that office documents now convert locally. Call out that scanned PDFs need OCR, embedded visuals may be incomplete, and spreadsheet Markdown is not authoritative for calculations.
