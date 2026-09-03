# Local Mattermost server

Read this only when discovering, repairing, or installing a local Mattermost.
The bundled Compose setup is for evaluation and NanoClaw development, not a
production deployment.

## Discovery

Probe configured and conventional URLs with Mattermost's health endpoint:

```bash
for url in "${MATTERMOST_BASE_URL:-}" http://localhost:8065 http://127.0.0.1:8065; do
  test -n "$url" || continue
  curl -fsS --max-time 2 "${url%/}/api/v4/system/ping"
done
```

Also inspect `docker ps -a` for images or names containing `mattermost`. Do not
assume every service on port 8065 is Mattermost. When localhost and 127.0.0.1
reach the same container, they are aliases, not two choices.

If a stopped installation is found, identify its Compose project or original
startup mechanism and offer to start it with that mechanism. Recreating an
unknown container can lose non-persisted configuration.

## Optional evaluation installation

Before proceeding, tell the user this creates a Mattermost Team Edition
container, PostgreSQL container, named data volumes, a Docker network, and a
host listener on port 8065. Confirm Docker and Compose are available and port
8065 is free, then obtain approval.

Copy the bundled template into a user-visible project directory so future
configuration changes remain reproducible:

```bash
mkdir -p .nanoclaw/mattermost
cp .claude/skills/add-mattermost/assets/compose.yml .nanoclaw/mattermost/compose.yml
umask 077
test -f .nanoclaw/mattermost/.env || printf 'MATTERMOST_DB_PASSWORD=%s\n' "$(openssl rand -hex 24)" > .nanoclaw/mattermost/.env
docker compose -f .nanoclaw/mattermost/compose.yml up -d
```

The generated database credential is local to this evaluation stack and is
stored mode-private beside its Compose file. Do not commit that `.env` file.

Wait for `http://localhost:8065/api/v4/system/ping` to become healthy. Stop
after a bounded wait and report container logs on failure; do not loop forever.
Then set:

```bash
MATTERMOST_BASE_URL=http://localhost:8065
```

Use this host name in Mattermost Desktop. This keeps the Desktop app and the
server on the same address. The template sets SiteURL for you. Use
`http://localhost:8065` in all settings. Do not use `127.0.0.1` in Desktop.
Keep `WebsocketURL` blank. The template does not change `AllowCorsFrom`. It
enables bot account creation. It permits callbacks only to the Docker host name
that a local NanoClaw installation uses.

The first browser visit creates the administrator and team; Mattermost always
allows creating the first account even with open signup disabled. The template
keeps open signup off, so anyone else who reaches the listener cannot
self-register — add further users through System Console invitations. Continue
with the bot-account steps in `SKILL.md` after that initialization is complete.

## Verification

Health:

```bash
curl -fsS http://localhost:8065/api/v4/system/ping
```

Client configuration. The first value must be the SiteURL. The second value
must be empty.

```bash
curl -fsS 'http://localhost:8065/api/v4/config/client?format=old' |
  jq -er '.SiteURL, (.WebsocketURL // "")'
```

WebSocket origin (a successful upgrade remains open, so use a timeout; seeing
`101 Switching Protocols` is success even when curl later reports a timeout):

```bash
curl -i --http1.1 --max-time 3 \
  -H 'Origin: http://localhost:8065' \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  http://localhost:8065/api/v4/websocket
```

Use `docker compose -f .nanoclaw/mattermost/compose.yml down` to stop the lab
without deleting data. Never add `-v` unless the user explicitly asks to erase
the Mattermost database and uploaded data.
