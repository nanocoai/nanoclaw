#!/usr/bin/env bash
# Gives container/build.sh a CONTAINER_RUNTIME whose `build` goes through a
# buildx builder with a layer cache on disk (restored and saved by the
# workflow) and never loads the image: the skills gate only proves the image
# still builds with the skill applied, nothing runs it. Every other docker
# subcommand passes straight through. The cache is only written back when the
# workflow restored none for the current image inputs (IMAGE_CACHE_HIT unset
# or false): exporting it costs as much as the build it saves.
set -euo pipefail

cache="$RUNNER_TEMP/image-cache"
bin="$RUNNER_TEMP/cached-container-runtime"
mkdir -p "$cache" "$bin"
docker buildx create --name skill-ci --driver docker-container --use >/dev/null

cat > "$bin/docker" <<WRAPPER
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" != build ]; then exec /usr/bin/docker "\$@"; fi
shift
opts=()
if [ -f "$cache/index.json" ]; then opts+=(--cache-from "type=local,src=$cache"); fi
if [ "\${IMAGE_CACHE_HIT:-false}" != true ]; then opts+=(--cache-to "type=local,dest=$cache.next,mode=max"); fi
/usr/bin/docker buildx build --builder skill-ci "\${opts[@]}" --output type=cacheonly "\$@"
if [ -d "$cache.next" ]; then rm -rf "$cache" && mv "$cache.next" "$cache"; fi
WRAPPER
chmod +x "$bin/docker"

echo "CONTAINER_RUNTIME=$bin/docker" >> "$GITHUB_ENV"
