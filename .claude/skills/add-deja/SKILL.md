---
name: add-deja
description: Add local coding-session search to NanoClaw agent containers with the pinned deja CLI. Use when agents need offline search across past sessions, recurring error fixes, and file history inside a group workspace.
---

# Add Deja

Install one pinned CLI and one focused container skill. Keep session indexing local inside each group container rather than modifying NanoClaw's core source files or uploading transcripts anywhere.

## Preflight

1. Read `CONTRIBUTING.md`, `docs/skill-guidelines.md`, and the supply-chain section of `docs/SECURITY.md`.
2. Run this check against the official npm registry before changing files:

   ```bash
   curl -fsSL "https://registry.npmjs.org/@vshulcz%2Fdeja-vu" | node -e '
     let body = "";
     process.stdin.setEncoding("utf8");
     process.stdin.on("data", (chunk) => (body += chunk));
     process.stdin.on("end", () => {
       const metadata = JSON.parse(body);
       const version = "0.24.3";
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

3. Inspect `container/cli-tools.json` for `@vshulcz/deja-vu` before changing files:
   - No entry: continue.
   - Exactly one entry at `0.24.3`: leave it unchanged.
   - A duplicate or any other version: stop and report the conflict.
4. Check whether `container/skills/search-past-sessions/SKILL.md` and `src/deja-manifest.test.ts` already exist. Reapplying this skill overwrites only those dedicated files.
5. If `data/v2.db` exists, inspect per-group image pins before changing files. Standard derived images can be rebuilt from the updated shared image. Stop and report any other pin because its owner must decide how to rebuild it:

   ```bash
   if [ -f data/v2.db ]; then
     project_root="$(git rev-parse --show-toplevel)"
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
       elif ! "$project_root/bin/ncl" groups get --id "$group_id" >/dev/null; then
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
skill_dir="${CLAUDE_SKILL_DIR:-$project_root/.claude/skills/add-deja}"
test -f "$skill_dir/container-skills/search-past-sessions/SKILL.md"
test -f "$skill_dir/deja-manifest.test.ts"
mkdir -p container/skills/search-past-sessions src
cp "$skill_dir/container-skills/search-past-sessions/SKILL.md" \
  container/skills/search-past-sessions/SKILL.md
cp "$skill_dir/deja-manifest.test.ts" src/deja-manifest.test.ts
```

If `container/cli-tools.json` has no `@vshulcz/deja-vu` entry, append this exact object to its JSON array. Do not add `onlyBuilt` because `@vshulcz/deja-vu` ships prebuilt optional platform packages with no install lifecycle scripts:

```json
{ "name": "@vshulcz/deja-vu", "version": "0.24.3" }
```

## Validate and build

Run validation before building the image:

```bash
pnpm exec vitest run src/deja-manifest.test.ts container/cli-tools.test.ts
pnpm run build
./container/build.sh
```

If `pnpm` rejects the package as too new during image build, stop. Do not bypass the release-age policy.

Rebuild standard per-group images so groups with custom packages inherit the updated shared image:

```bash
if [ -f data/v2.db ]; then
  project_root="$(git rev-parse --show-toplevel)"
  source setup/lib/install-slug.sh
  image_base="$(container_image_base)"
  while IFS='|' read -r group_id image_tag; do
    [ -z "$group_id" ] && continue
    if [ "$image_tag" != "${image_base}:${group_id}" ]; then
      echo "Foreign image pin appeared during install: $group_id -> $image_tag" >&2
      exit 1
    fi
    "$project_root/bin/ncl" groups restart --id "$group_id" --rebuild
  done < <(pnpm exec tsx scripts/q.ts data/v2.db \
    "SELECT agent_group_id, image_tag FROM container_configs WHERE image_tag IS NOT NULL ORDER BY agent_group_id")
fi
```

Resolve this install's base image name and exercise both the binary and an offline synthetic index-and-recall pass:

```bash
source setup/lib/install-slug.sh
image="$(container_image_base):latest"
docker run --rm --entrypoint deja "$image" --version
docker run --rm --entrypoint sh "$image" -c '
  set -e
  tmp="$(mktemp -d)"
  trap "rm -rf \"$tmp\"" EXIT
  mkdir -p "$tmp/.claude/projects/smoke" "$tmp/index"
  printf "{\"type\":\"user\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"canary token alpha91 smoke check\"}}\n" \
    > "$tmp/.claude/projects/smoke/smoke-1.jsonl"
  HOME="$tmp" DEJA_INDEX_DIR="$tmp/index" deja index --quiet
  HOME="$tmp" DEJA_INDEX_DIR="$tmp/index" deja recall "alpha91" | grep -q "alpha91"
'
```

## Restart

Restart this NanoClaw service only so running containers stop and default `skills: "all"` groups receive `search-past-sessions` on their next spawn:

```bash
source setup/lib/install-slug.sh
# macOS
launchctl kickstart -k "gui/$(id -u)/$(launchd_label)"
# Linux
systemctl --user restart "$(systemd_unit)"
```

Run only the command for the current platform. If NanoClaw is not service-managed, stop this install's running agent containers by their `nanoclaw-install=<install-slug>` label instead of matching every `nanoclaw-v2` container on the host.

## Smoke test

In a real group conversation:

1. Ask the agent to run `export DEJA_INDEX_DIR=/home/node/.claude/.deja-index && deja index --quiet && deja status --json` and confirm it reports local session state inside `/home/node/.claude/.deja-index`.
2. Ask a question matching an earlier phrase in the group's conversation and verify `deja recall` returns the session locally with no external uploads.

## Troubleshooting

- **72-hour npm release gate fails**: the pinned version is newer than 72 hours or unavailable on the npm registry. Wait until the cooldown passes instead of adding exceptions or disabling release-age checks.
- **`deja: command not found` inside a group container**: `container/cli-tools.json` was updated without rebuilding the image or restarting the group. Run `./container/build.sh` and restart the NanoClaw service.
- **Derived group image still lacks `deja` or the skill**: groups pinned in `container_configs` keep older derived layers until rebuilt. Run `"$project_root/bin/ncl" groups restart --id "$group_id" --rebuild` for each derived group.
