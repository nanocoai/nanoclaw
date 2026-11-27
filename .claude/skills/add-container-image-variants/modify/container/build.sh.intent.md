# Intent: container/build.sh modifications

## What changed
The build script now discovers and builds all container image variants in
addition to the default `nanoclaw-agent:latest` image.

## New behaviour
- Defines a `build_image(dockerfile, image_name)` helper
- Builds `container/Dockerfile` → `nanoclaw-agent:{tag}` (unchanged default)
- Scans all subdirectories of `container/`:
  - Skips `agent-runner` and `skills` (not image variants)
  - If `{dir}/Dockerfile` exists → builds `nanoclaw-agent-{dir}:{tag}`
  - If `{dir}/Containerfile` exists → builds `nanoclaw-agent-{dir}:{tag}`
- Build context for ALL images is `container/` (so variants can `COPY agent-runner/`)

## Invariants (must-keep)
- `CONTAINER_RUNTIME` env var override still works (default: `docker`)
- `TAG` argument (`./build.sh [tag]`) still works
- Default image name `nanoclaw-agent` unchanged
- Test command echo at end unchanged in format
