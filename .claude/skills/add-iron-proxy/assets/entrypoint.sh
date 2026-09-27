#!/bin/sh
set -eu
if [ "${1:-}" = "generate-ca" ]; then
  exec /usr/local/bin/iron-proxy "$@"
fi
# The only network-facing listener belongs to NanoClaw. Stock Iron is loopback-only.
exec /usr/local/bin/nanoclaw-iron-front --config /etc/iron-proxy/front.json --iron-config /etc/iron-proxy/config.yaml
