#!/bin/sh
# NanoClaw Squid container entrypoint.
#
# Runs three kinds of daemons in one container:
#   - dnsmasq (NXDOMAIN black-hole for all DNS queries from agents,
#              logging every query so operators can review attempted
#              exfiltration)
#   - squid (HTTP/HTTPS proxy with per-source-IP ACLs, forwards via
#            cache_peer parent to OneCLI)
#   - socat per-agent CDP TCP-forwarders (optional, only when the host
#            has written /etc/socat-forwards.conf): each line specifies
#            an agent's egress port → host CDP-proxy port + source-IP
#            allowlist. Needed because the Playwright/ws library used by
#            agent-browser doesn't honor HTTP_PROXY for WebSocket
#            connections — without these TCP tunnels, the WS handshake
#            for CDP can't traverse the --internal egress network.
#
# Logs to /var/log/squid/ (host bind-mount). SIGTERM/SIGINT forwarded to
# all daemons via trap so shutdown is clean.

set -e

mkdir -p /var/log/squid

# Squid 6 dropped `dns_v4_first` and follows the system resolver's address
# ordering. On Docker Desktop, `host.docker.internal` resolves to both an
# IPv6 ULA and an IPv4 — and the IPv6 is returned first. OneCLI binds only
# to IPv4, so Squid's first cache_peer attempt silently fails on the IPv6
# address and the peer is marked DEAD — every CONNECT then 500s.
# Resolve to IPv4 here, copy the mounted config to a writable location
# with the literal IPv4 substituted into the `cache_peer` line, and run
# squid against the copy.
#
# Scope the sed to `cache_peer` lines only: `dstdomain host.docker.internal`
# ACLs (used by per-agent host-service grants) must keep the hostname,
# because Squid matches `dstdomain` against the literal hostname in the
# client's request URL — rewriting it to an IP makes those ACLs never
# fire and host-service traffic gets denied.
HOST_V4=$(getent ahostsv4 host.docker.internal 2>/dev/null | awk 'NR==1 {print $1}')
if [ -n "$HOST_V4" ]; then
  cp /etc/squid/squid.conf /tmp/squid.conf
  sed -i "/^cache_peer /s/host\.docker\.internal/$HOST_V4/g" /tmp/squid.conf
  SQUID_CONF=/tmp/squid.conf
else
  echo "entrypoint: warning — host.docker.internal didn't resolve to IPv4; using config as-is" >&2
  SQUID_CONF=/etc/squid/squid.conf
fi

# dnsmasq config is mounted by the host along with squid.conf.
dnsmasq --keep-in-foreground --conf-file=/etc/dnsmasq.conf &
DNSMASQ_PID=$!

squid -N -f "$SQUID_CONF" &
SQUID_PID=$!

# CDP TCP-forwarders.
# File format (one forward per non-empty/non-# line):
#   <listen-port> <source-ip-or-cidr> <upstream-host> <upstream-port>
# Example:
#   9222 172.30.0.5/32 host.docker.internal 9222
SOCAT_PIDS=""
if [ -r /etc/socat-forwards.conf ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue;; esac
    set -- $line
    LISTEN_PORT="$1"; SRC_RANGE="$2"; UP_HOST="$3"; UP_PORT="$4"
    if [ -z "$LISTEN_PORT" ] || [ -z "$SRC_RANGE" ] || [ -z "$UP_HOST" ] || [ -z "$UP_PORT" ]; then
      echo "socat-forwards: skipping malformed line: $line" >&2
      continue
    fi
    echo "socat: forwarding :$LISTEN_PORT (src=$SRC_RANGE) → $UP_HOST:$UP_PORT" >&2
    socat \
      "TCP4-LISTEN:$LISTEN_PORT,reuseaddr,fork,range=$SRC_RANGE" \
      "TCP4:$UP_HOST:$UP_PORT" \
      >>/var/log/squid/socat.log 2>&1 &
    SOCAT_PIDS="$SOCAT_PIDS $!"
  done < /etc/socat-forwards.conf
fi

# Forward SIGTERM/SIGINT to all daemons and wait for squid to exit.
trap 'kill -TERM '"$DNSMASQ_PID $SQUID_PID $SOCAT_PIDS"' 2>/dev/null || true' TERM INT

# Wait for squid to exit; on its exit, the container exits.
wait "$SQUID_PID"
EXIT=$?
# shellcheck disable=SC2086
kill -TERM "$DNSMASQ_PID" $SOCAT_PIDS 2>/dev/null || true
wait "$DNSMASQ_PID" 2>/dev/null || true
exit $EXIT
