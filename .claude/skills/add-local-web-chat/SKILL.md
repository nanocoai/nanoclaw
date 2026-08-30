---
name: add-local-web-chat
description: Add a loopback-only browser chat for any NanoClaw agent group. Use for a small local web UI without installing a messaging platform or changing the group's model provider.
---

# Add local web chat

Install a provider-neutral browser UI at `http://127.0.0.1:3210`. It uses the
normal NanoClaw channel, router, session, and delivery paths; the selected agent
keeps its existing provider and model.

## Apply

### 1. Copy the adapter, page, and tests

Fetch the `channels` branch and copy the local web adapter, page, registration
test, and behavior tests. The registry branch is the canonical source, so
re-applying the skill overwrites these files.

```nc:copy from-branch:channels
src/channels/local-web.ts
src/channels/local-web-page.html
src/channels/local-web-page.css
src/channels/local-web-page.js
src/channels/local-web-registration.test.ts
src/channels/local-web.test.ts
```

### 2. Register the adapter

```nc:append to:src/channels/index.ts
import './local-web.js';
```

### 3. Install Markdown rendering

Pinned to an exact version; the adapter's unmocked behavior test imports it.

```nc:dep
markdown-it@15.0.0
```

### 4. Build and validate

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/channels/local-web-registration.test.ts src/channels/local-web.test.ts
```

### 5. Restart NanoClaw

```nc:run effect:restart
pnpm exec tsx setup/index.ts --step service
```

## Wire an agent

The browser is the single machine-local identity `local-web:local`. Ask whether
that identity should be an owner, admin, or member, then register and wire it
through NanoClaw's shared first-agent flow. Replace the placeholders with the
operator name, role, and agent ID from `ncl groups list`.

```bash
pnpm exec tsx scripts/init-first-agent.ts \
  --channel local-web \
  --user-id local-web:local \
  --platform-id local \
  --display-name "<operator-name>" \
  --agent-group-id <agent-group-id> \
  --role <owner|admin|member>
```

Only after the shared wiring command succeeds, open the chat. Open the URL, do
not print it: the token is a secret and this runs inside an agent transcript.

```bash
PORT=$(grep -E '^NANOCLAW_LOCAL_WEB_PORT=' .env | cut -d= -f2)
URL="http://127.0.0.1:${PORT:-3210}/#token=$(cat data/local-web/token)"
case "$(uname)" in Darwin) open "$URL" ;; *) xdg-open "$URL" ;; esac
```

The browser stores the token and strips it from the address bar, so this runs
once per browser. If no browser opens (a headless or remote host), tell the
operator to run that snippet themselves with `echo "$URL"` on the end, in their
own terminal. Anyone who can read `data/local-web/token` can use the chat; the
file is `0600` and is never mounted into an agent container.

The shared wiring command queues the standard `/welcome` turn. Opening or
reconnecting the browser never creates a message.
To choose another port, persist it before the restart step and offer that URL
instead:

```bash
pnpm exec tsx setup/index.ts --step set-env -- --key NANOCLAW_LOCAL_WEB_PORT --value <port>
```

Binding to `127.0.0.1` is not by itself an access control: agent containers reach
host loopback ports through `host.docker.internal`. The adapter therefore requires
the token on `/events`, `/api/messages`, and `/api/actions`, which is what keeps a
container from resolving its own approval cards. The loopback Host and same-origin
checks stay as defense-in-depth. The token is read once at startup, so revoking it
means deleting `data/local-web/token` and restarting the host.

The server accepts only loopback Host and same-origin browser requests. Messages
are limited to 8,000 characters. Agent replies render standard Markdown; raw
HTML is escaped and unsafe link schemes are not linked. Rendered and
tab-stored history are capped at the latest 100 items. Replies produced while
the tab is closed are queued until it reconnects. Agent questions and protected
actions render as buttons; the host resolves the selected option from its
pending row and applies the normal role checks before acting. While a turn runs,
the page shows the current tool name without its arguments or results.

## Troubleshooting

- **Page unavailable:** check `logs/nanoclaw.error.log` for an occupied port or adapter startup failure.
- **Messages receive no reply:** confirm `ncl wirings list` contains the `local-web` conversation and the intended agent.
- **Request rejected:** open the printed `127.0.0.1` URL directly; proxied and embedded origins are denied.
- **"This browser has no access token":** the tab predates the token or its storage was cleared. Re-open the chat with the snippet under "Wire an agent". Ask the operator to run it in their own terminal if they need the URL printed; it carries a secret, so do not echo it into a chat or an agent transcript.
