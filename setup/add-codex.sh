#!/usr/bin/env bash
#
# Install the Codex agent provider non-interactively: copy the payload from the
# `providers` branch, wire the three provider barrels, and add the Codex CLI to
# the container manifest (container/cli-tools.json). The image rebuild is the
# caller's job (the setup container step / `./container/build.sh`).
#
# Emits exactly one status block on stdout (ADD_CODEX); all chatty progress
# goes to stderr. Keep in sync with .claude/skills/add-codex/SKILL.md.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Keep in sync with add-codex SKILL.md. This is the canonical Codex CLI pin —
# it lands in container/cli-tools.json (the global-CLI manifest), not the Dockerfile.
CODEX_VERSION="0.138.0"

# Resolve the remote carrying the providers branch (same nanoclaw remote that
# carries channels — handles forks where it isn't `origin`).
# shellcheck source=setup/lib/channels-remote.sh
source "$PROJECT_ROOT/setup/lib/channels-remote.sh"
REMOTE=$(resolve_channels_remote)
BRANCH="${REMOTE}/providers"

# The codex payload — host provider, container runtime, setup module, doctrine.
# Barrels are appended to, not copied.
PAYLOAD_FILES=(
  src/providers/codex.ts
  src/providers/codex-agents-md.ts
  src/providers/codex-registration.test.ts
  src/providers/codex-host-contribution.test.ts
  src/providers/codex-agents-md.test.ts
  container/agent-runner/src/providers/codex.ts
  container/agent-runner/src/providers/codex-app-server.ts
  container/agent-runner/src/providers/exchange-archive.ts
  container/agent-runner/src/providers/exchange-archive.test.ts
  container/agent-runner/src/providers/codex-registration.test.ts
  container/agent-runner/src/providers/codex.factory.test.ts
  container/agent-runner/src/providers/codex.turns.test.ts
  container/agent-runner/src/providers/codex-app-server.test.ts
  container/agent-runner/src/providers/codex-cli-tools.test.ts
  setup/providers/codex.ts
  setup/providers/codex.test.ts
  setup/providers/codex-registration.test.ts
  container/AGENTS.md
)
BARRELS=(
  src/providers/index.ts
  container/agent-runner/src/providers/index.ts
  setup/providers/index.ts
)

ALREADY_INSTALLED=true
emit_status() {
  local status=$1 error=${2:-}
  echo "=== NANOCLAW SETUP: ADD_CODEX ==="
  echo "STATUS: ${status}"
  echo "CODEX_VERSION: ${CODEX_VERSION}"
  echo "ALREADY_INSTALLED: ${ALREADY_INSTALLED}"
  [ -n "$error" ] && echo "ERROR: ${error}"
  echo "=== END ==="
}
log() { echo "[add-codex] $*" >&2; }

# Idempotent: a complete install has the host provider file, the host barrel
# import, and the Codex CLI in the container manifest. Any missing → (re)install.
need_install() {
  [ ! -f src/providers/codex.ts ] && return 0
  ! grep -q "^import './codex.js';" src/providers/index.ts 2>/dev/null && return 0
  ! grep -q '@openai/codex' container/cli-tools.json 2>/dev/null && return 0
  return 1
}

if need_install; then
  ALREADY_INSTALLED=false

  log "Fetching providers branch from ${REMOTE}…"
  git fetch "$REMOTE" providers >&2 2>/dev/null || {
    emit_status failed "git fetch ${REMOTE} providers failed"
    exit 1
  }

  log "Copying Codex payload from ${BRANCH}…"
  for f in "${PAYLOAD_FILES[@]}"; do
    mkdir -p "$(dirname "$f")"
    git show "${BRANCH}:$f" > "$f" 2>/dev/null || {
      emit_status failed "providers branch is missing ${f}"
      exit 1
    }
  done

  log "Wiring provider barrels…"
  for b in "${BARRELS[@]}"; do
    grep -q "^import './codex.js';" "$b" || printf "import './codex.js';\n" >> "$b"
  done

  log "Adding the Codex CLI to the container manifest (cli-tools.json)…"
  # A json-merge: append { name, version } if absent. The Dockerfile installs
  # every manifest entry via pinned `pnpm install -g` — no Dockerfile edit, no
  # awk surgery. @openai/codex has no native postinstall, so no "onlyBuilt".
  MANIFEST=container/cli-tools.json
  node -e '
    const fs = require("fs");
    const [file, name, version] = process.argv.slice(1);
    const tools = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!tools.some((t) => t.name === name)) {
      tools.push({ name, version });
      const fmt = (t) =>
        "  { " +
        Object.entries(t).map(([k, v]) => JSON.stringify(k) + ": " + JSON.stringify(v)).join(", ") +
        " }";
      fs.writeFileSync(file, "[\n" + tools.map(fmt).join(",\n") + "\n]\n");
    }
  ' "$MANIFEST" "@openai/codex" "${CODEX_VERSION}" || {
    emit_status failed "failed to add @openai/codex to ${MANIFEST}"
    exit 1
  }
fi

emit_status ok
