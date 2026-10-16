---
name: add-container-image-variants
description: Support per-group container images in NanoClaw. Each group can specify a custom container image via containerConfig.image, with a global default. The build script is also extended to discover and build all image variants automatically. Use when different agent groups need different tools or environments.
---

# Add Container Image Variants

This skill adds two capabilities:

1. **Per-group container image** — each group can specify `containerConfig.image` to run a custom image instead of the default `nanoclaw-agent:latest`.
2. **Multi-image build script** — `container/build.sh` discovers and builds all image variants found in `container/*/Dockerfile` or `container/*/Containerfile`.

## What this changes

| File | Change |
|------|--------|
| `src/types.ts` | Add `image?: string` to `ContainerConfig` |
| `src/container-runner.ts` | Use `group.containerConfig?.image` with fallback to `CONTAINER_IMAGE` |
| `container/build.sh` | Discover and build variant images under `container/*/` |

**What stays the same:**
- Default image (`nanoclaw-agent:latest`) and all existing behaviour
- Mount security, allowlist validation, IPC — all unchanged
- Groups without `containerConfig.image` continue using the default

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `add-container-image-variants` is in `applied_skills`, this skill is already applied. Confirm with the user and stop.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-container-image-variants
```

This deterministically:
- Merges `image?: string` into `ContainerConfig` in `src/types.ts`
- Updates the image selection line in `src/container-runner.ts`
- Replaces `container/build.sh` with the multi-image version
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/types.ts.intent.md`
- `modify/src/container-runner.ts.intent.md`
- `modify/container/build.sh.intent.md`

### Validate

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Create a Variant Image (Optional)

To use a custom image for a group, create a variant Dockerfile:

```bash
mkdir -p container/my-variant
# Write a Dockerfile — build context is container/, so you can COPY agent-runner/
```

Example `container/my-variant/Dockerfile`:

```dockerfile
FROM nanoclaw-agent:latest
# Add your tools on top of the default image
RUN apt-get update && apt-get install -y <your-packages> && rm -rf /var/lib/apt/lists/*
```

### Build all images

```bash
CONTAINER_RUNTIME=${CONTAINER_RUNTIME:-docker} ./container/build.sh
```

This builds `nanoclaw-agent:latest` plus `nanoclaw-agent-my-variant:latest`.

### Assign the image to a group

From the main channel, ask the agent to update the group's container config, or update the SQLite database directly:

```bash
sqlite3 store/messages.db \
  "UPDATE registered_groups SET container_config = json_set(COALESCE(container_config, '{}'), '$.image', 'nanoclaw-agent-my-variant:latest') WHERE folder = 'my-group';"
```

## Phase 4: Verify

### Check image selection is applied

```bash
npm run build && grep -n "containerConfig?.image" src/container-runner.ts
```

Expected: one match on the line that pushes the image argument.

### Test the default image still works

```bash
echo '{"prompt":"ping","groupFolder":"test","chatJid":"test@g.us","isMain":false}' \
  | ${CONTAINER_RUNTIME:-docker} run -i nanoclaw-agent:latest
```

### Confirm build script discovers variants

Create a test variant and verify it is picked up:

```bash
mkdir -p /tmp/test-variant-check
cp container/Dockerfile /tmp/test-variant-check/Dockerfile
# Dry-run: just list what would be built
grep -n 'build_image\|for dir' container/build.sh
```

## Troubleshooting

**Group still uses default image after setting `containerConfig.image`:**
- Restart the NanoClaw service so the new DB value is read
- Verify the column was updated: `sqlite3 store/messages.db "SELECT folder, container_config FROM registered_groups;"`

**Build script skips a subdirectory:**
- Check the directory isn't listed in `SKIP_DIRS` (`agent-runner`, `skills`)
- Verify the file is named exactly `Dockerfile` or `Containerfile` (case-sensitive)

**Variant image not found at runtime:**
- Build it first: `./container/build.sh`
- Confirm it exists: `${CONTAINER_RUNTIME:-docker} images | grep nanoclaw-agent`

## Summary of Changed Files

| File | Type of Change |
|------|---------------|
| `src/types.ts` | Add `image?: string` field to `ContainerConfig` interface |
| `src/container-runner.ts` | Use per-group image with fallback to global default |
| `container/build.sh` | Multi-image discovery and build |
