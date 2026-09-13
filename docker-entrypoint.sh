#!/bin/sh
set -e

echo "=== NanoClaw startup ==="

# Pre-flight: validate required credentials before touching any state.
# Exit early so the container can be corrected without leaving behind
# a partially-initialised data directory that corrupts future starts.

_preflight_ok=1

# Claude API key (required — without this nothing works)
if [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
    echo ""
    echo "ERROR: No Claude API key found."
    echo "  Please set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN."
    _preflight_ok=0
fi

# At least one channel credential (required — no channel = nothing to respond to)
if [ -z "$TELEGRAM_BOT_TOKEN" ] && \
   [ -z "$WHATSAPP_TOKEN" ] && \
   [ -z "$SLACK_BOT_TOKEN" ] && \
   [ -z "$DISCORD_BOT_TOKEN" ]; then
    echo ""
    echo "ERROR: No channel credentials found."
    echo "  Please set at least one of the following before starting NanoClaw:"
    echo "    TELEGRAM_BOT_TOKEN"
    echo "    WHATSAPP_TOKEN"
    echo "    SLACK_BOT_TOKEN"
    echo "    DISCORD_BOT_TOKEN"
    _preflight_ok=0
fi

if [ "$_preflight_ok" = "0" ]; then
    echo ""
    echo "NanoClaw will not start until the above credentials are configured."
    echo "Fix the missing variables and restart the container."
    exit 1
fi

# Build agent image if not present on host
if ! docker image inspect nanoclaw-agent:latest > /dev/null 2>&1; then
    echo "Building nanoclaw-agent image..."
    cd /app/container && sh build.sh
    cd /app
else
    echo "nanoclaw-agent image found, skipping build."
fi

# Pre-create persistent data directory structure so volume mounts
# don't start empty and cause runtime errors on first boot
mkdir -p \
    /app/data/sessions \
    /app/data/env \
    /app/data/ipc \
    /app/logs \
    /app/store

chown -R 1000:1000 /app/data/sessions

# Seed a minimal .claude.json for each existing group session directory
# so claude-code considers itself logged in without needing the host's real token file.
for session_dir in /app/data/sessions/*/; do
    [ -d "$session_dir" ] || continue
    claude_json="$session_dir.claude.json"
    if [ ! -f "$claude_json" ]; then
        cat > "$claude_json" <<'EOF'
{
  "hasCompletedOnboarding": true,
  "lastOnboardingVersion": "2.1.76",
  "oauthAccount": {
    "accountUuid": "00000000-0000-0000-0000-000000000000",
    "emailAddress": "agent@nanoclaw.local",
    "organizationUuid": "00000000-0000-0000-0000-000000000000",
    "displayName": "NanoClaw Agent",
    "organizationRole": "admin",
    "organizationName": "NanoClaw"
  }
}
EOF
        chown 1000:1000 "$claude_json"
        echo "Seeded .claude.json for $session_dir"
    fi
done

echo "Starting NanoClaw..."
exec node dist/index.js
