#!/bin/bash
# NanoClaw agent container entrypoint.
#
# The host passes initial session parameters via stdin as a single JSON blob,
# then the agent-runner opens the session DBs at /workspace/{inbound,outbound}.db
# and enters its poll loop. All further IO flows through those DBs.
#
# We capture stdin to a file first so /tmp/input.json is available for
# post-mortem inspection if the container exits unexpectedly, then exec bun
# so that bun becomes PID 1's direct child (under tini) and receives signals.
#
# Apple Container support:
#   Apple Container's VirtioFS only supports directory bind mounts, so the
#   host cannot shadow /workspace/project/.env with /dev/null the way Docker
#   does. Instead, main-group containers start as root, shadow .env from
#   inside via `mount --bind`, then drop to the unprivileged user via
#   setpriv. RUN_UID / RUN_GID are set by the host runner.

set -e

# Shadow .env so the agent cannot read host secrets. Only meaningful when
# we start as root (Apple Container main-group containers); harmless otherwise.
if [ "$(id -u)" = "0" ] && [ -f /workspace/project/.env ]; then
  mount --bind /dev/null /workspace/project/.env
fi

cat > /tmp/input.json

# Drop privileges if started as root. Non-main containers (and Docker) are
# launched with --user node, never enter this branch.
if [ "$(id -u)" = "0" ] && [ -n "$RUN_UID" ]; then
  chown "$RUN_UID:${RUN_GID:-$RUN_UID}" /tmp/input.json
  exec setpriv --reuid="$RUN_UID" --regid="${RUN_GID:-$RUN_UID}" --clear-groups -- bun run /app/src/index.ts < /tmp/input.json
fi

exec bun run /app/src/index.ts < /tmp/input.json
