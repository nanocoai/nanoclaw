#!/bin/sh
set -eu

install -d -m 0700 "$NANOCLAW_DATA_DIR" "$NANOCLAW_GROUPS_DIR" "$NANOCLAW_STORE_DIR"
install -d -m 0700 /var/lib/nanoclaw/secrets
install -m 0600 /run/nanoclaw/secrets/central-db-password /var/lib/nanoclaw/secrets/central-db-password
install -m 0600 /run/nanoclaw/secrets/central-db-migrate-password /var/lib/nanoclaw/secrets/central-db-migrate-password
if [ ! -e "$NANOCLAW_DATA_DIR/upgrade-state.json" ]; then
  cp /opt/nanoclaw/bootstrap/upgrade-state.json "$NANOCLAW_DATA_DIR/upgrade-state.json"
fi
exec node /opt/nanoclaw/dist/index.js
