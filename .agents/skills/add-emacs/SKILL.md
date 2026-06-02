---
name: add-emacs
description: Add Emacs as a channel. Opens an interactive chat buffer and org-mode integration so you can talk to NanoClaw from within Emacs (Doom, Spacemacs, or vanilla). Local HTTP bridge — no bot token or external service needed.
---

# Add Emacs Channel

Adds Emacs support via a local HTTP bridge. Works with Doom Emacs, Spacemacs, and vanilla Emacs 27.1+.

## What you can do with this

- **Ask while coding** — open the chat buffer (`C-c n c` / `SPC N c`), ask about a function or error without leaving Emacs
- **Code review** — select a region and send it with `nanoclaw-org-send`; the response appears as a child heading inline in your org file
- **Meeting notes** — send an org agenda entry; get a summary or action item list back as a child node
- **Draft writing** — send org prose; receive revisions or continuations in place
- **Research capture** — ask a question directly in your org notes; the answer lands exactly where you need it

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the Emacs adapter and the Lisp client in from the `channels` branch. Native HTTP bridge — no Chat SDK, no adapter package.

### Pre-flight (idempotent)

Skip to **Enable** if all of these are already in place:

- `src/channels/emacs.ts` exists
- `emacs/nanoclaw.el` exists
- `src/channels/index.ts` contains `import './emacs.js';`

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter and Lisp client

```bash
mkdir -p emacs
git show origin/channels:src/channels/emacs.ts      > src/channels/emacs.ts
git show origin/channels:src/channels/emacs.test.ts > src/channels/emacs.test.ts
git show origin/channels:emacs/nanoclaw.el          > emacs/nanoclaw.el
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './emacs.js';
```

### 4. Build

```bash
pnpm run build
```

No npm package to install — the adapter uses only Node builtins (`http`).

## Enable

The adapter is gated by `EMACS_ENABLED` so the HTTP port isn't opened on hosts that aren't running Emacs. Add to `.env`:

```bash
EMACS_ENABLED=true
EMACS_CHANNEL_PORT=8766       # optional — change only if 8766 is taken
EMACS_AUTH_TOKEN=             # optional — set to a random string to lock the endpoint
EMACS_PLATFORM_ID=default     # optional — only change if you want a non-default chat id
```

Generate an auth token (recommended even on single-user machines — prevents other local processes from poking the endpoint):

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

## Wire the channel

Emacs is a single-user, single-chat channel. One host = one messaging group with `platform_id = "default"`.

### If this is your first agent group

Run `/init-first-agent` — pick **Emacs** as the channel, use any short handle as the "user id" (e.g. your OS username), and the skill will create the agent group, wire the channel, and write a welcome message that the agent delivers back to your Emacs buffer.

### Otherwise — wire to an existing agent group

Run the `register` step directly. The `EMACS_PLATFORM_ID` (default `default`) becomes the messaging group's platform id:

```bash
pnpm exec tsx setup/index.ts --step register -- \
  --platform-id "default" --name "Emacs" \
  --folder "<existing-folder>" --channel "emacs" \
  --session-mode "agent-shared" \
  --assistant-name "<existing-assistant-name>"
```

`agent-shared` puts Emacs messages in the same session as any other channel wired to the same agent group — so a conversation you started in Telegram continues in Emacs. Use `shared` to keep an independent Emacs thread with the same workspace, or a new `--folder` for a dedicated Emacs-only agent.

## Configure Emacs

`nanoclaw.el` needs only Emacs 27.1+ builtins (`url`, `json`, `org`) — no package manager.

AskUserQuestion: Which Emacs distribution are you using?
- **Doom Emacs** — `config.el` with `map!` keybindings
- **Spacemacs** — `dotspacemacs/user-config` in `~/.spacemacs`
- **Vanilla Emacs / other** — `init.el` with `global-set-key`

**Doom Emacs** — add to `~/.config/doom/config.el` (or `~/.doom.d/config.el`):

```elisp
;; NanoClaw — personal AI assistant channel
(load (expand-file-name "~/src/nanoclaw/emacs/nanoclaw.el"))

(map! :leader
      :prefix ("N" . "NanoClaw")
      :desc "Chat buffer"  "c" #'nanoclaw-chat
      :desc "Send org"     "o" #'nanoclaw-org-send)
```

Reload: `M-x doom/reload`

**Spacemacs** — add to `dotspacemacs/user-config` in `~/.spacemacs`:

```elisp
;; NanoClaw — personal AI assistant channel
(load-file "~/src/nanoclaw/emacs/nanoclaw.el")

(spacemacs/set-leader-keys "aNc" #'nanoclaw-chat)
(spacemacs/set-leader-keys "aNo" #'nanoclaw-org-send)
```

Reload: `M-x dotspacemacs/sync-configuration-layers` or restart Emacs.

**Vanilla Emacs** — add to `~/.emacs.d/init.el`:

```elisp
;; NanoClaw — personal AI assistant channel
(load-file "~/src/nanoclaw/emacs/nanoclaw.el")

(global-set-key (kbd "C-c n c") #'nanoclaw-chat)
(global-set-key (kbd "C-c n o") #'nanoclaw-org-send)
```

Reload: `M-x eval-buffer` or restart Emacs.

Replace `~/src/nanoclaw/emacs/nanoclaw.el` with your actual NanoClaw checkout path.

If `EMACS_AUTH_TOKEN` is set, also add (any distribution):

```elisp
(setq nanoclaw-auth-token "<your-token>")
```

If you changed `EMACS_CHANNEL_PORT` from the default:

```elisp
(setq nanoclaw-port <your-port>)
```

## Restart NanoClaw

Run from your NanoClaw project root:

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
# systemctl --user restart $(systemd_unit)             # Linux
```

## Verify

### HTTP endpoint

```bash
curl -s http://localhost:8766/api/messages?since=0
```

Expected: `{"messages":[]}`. With an auth token:

```bash
curl -s -H "Authorization: Bearer <token>" http://localhost:8766/api/messages?since=0
```

### From Emacs

Tell the user:

> 1. Open the chat buffer with your keybinding (`SPC N c`, `SPC a N c`, or `C-c n c`)
> 2. Type a message and press `C-c C-c` to send (RET inserts newlines)
> 3. A response should appear within a few seconds
>
> For org-mode: open any `.org` file, position the cursor on a heading, and use `SPC N o` / `SPC a N o` / `C-c n o`

### Log line

`tail -f logs/nanoclaw.log` should show `Emacs channel listening` at startup.

## Channel Info

- **type**: `emacs`
- **terminology**: Single local buffer. There are no "groups" or separate chats — one host = one chat, addressed by a `platform_id` string (default `default`).
- **how-to-find-id**: The platform id is whatever you set in `EMACS_PLATFORM_ID` (default `default`). User handles are arbitrary; your OS username or first name is fine (e.g. `emacs:<username>`).
- **supports-threads**: no
- **typical-use**: Single developer talking to the assistant from within Emacs, alongside whatever other channel they use (Slack, Telegram, Discord).
- **default-isolation**: Same agent group as the primary DM, with `session-mode = agent-shared` so a conversation started elsewhere continues in Emacs. Pick a separate folder only if you specifically want an Emacs-only persona.

### Features

- Interactive chat buffer (`nanoclaw-chat`) with markdown → org-mode rendering
- Org integration (`nanoclaw-org-send`) — sends the current subtree or region; reply lands as a child heading
- Optional bearer-token auth for the local endpoint
- Single-user: the adapter exposes exactly one messaging group per host

Not applicable (design): multi-user channels, threads, cold DM initiation, typing indicators, attachments.

## Troubleshooting

### Port already in use

```
Error: listen EADDRINUSE: address already in use :::8766
```

Either a stale NanoClaw is running or another app has the port. Kill stale process or change port:

```bash
lsof -ti :8766 | xargs kill -9
# or set EMACS_CHANNEL_PORT in .env and mirror in Emacs config (nanoclaw-port)
```

### Adapter not starting

If `grep "Emacs channel listening" logs/nanoclaw.log` returns nothing, check that `EMACS_ENABLED=true` is in `.env` and that the adapter import is present:

```bash
grep -q '^EMACS_ENABLED=true' .env && echo "enabled" || echo "not enabled"
grep -q "import './emacs.js'" src/channels/index.ts && echo "imported" || echo "not imported"
```

### No response from agent

1. NanoClaw running: `launchctl list | grep "$(. setup/lib/install-slug.sh && launchd_label)"` (macOS) / `systemctl --user status "$(. setup/lib/install-slug.sh && systemd_unit)"` (Linux)
2. Messaging group wired: `pnpm exec tsx scripts/q.ts data/v2.db "SELECT mg.platform_id, ag.folder FROM messaging_groups mg JOIN messaging_group_agents mga ON mg.id = mga.messaging_group_id JOIN agent_groups ag ON ag.id = mga.agent_group_id WHERE mg.channel_type = 'emacs'"`
3. Logs show inbound: `grep 'channel_type=emacs\|Emacs' logs/nanoclaw.log | tail -20`

If no messaging group row exists, run the `register` command above.

### Auth token mismatch (401 Unauthorized)

```elisp
M-x describe-variable RET nanoclaw-auth-token RET
```

Must match `EMACS_AUTH_TOKEN` in `.env`. If you didn't set one server-side, clear it in Emacs too:

```elisp
(setq nanoclaw-auth-token nil)
```

### nanoclaw.el not loading

```bash
ls ~/src/nanoclaw/emacs/nanoclaw.el
```

If NanoClaw is cloned elsewhere, update the `load`/`load-file` path in your Emacs config.

## Agent Formatting

The Emacs bridge converts markdown → org-mode automatically. Agents should output standard markdown, **not** org-mode syntax:

| Markdown | Org-mode |
|----------|----------|
| `**bold**` | `*bold*` |
| `*italic*` | `/italic/` |
| `~~text~~` | `+text+` |
| `` `code` `` | `~code~` |
| ` ```lang ` | `#+begin_src lang` |

If an agent outputs org-mode directly, markers get double-converted and render incorrectly.

## Removal

Run from your NanoClaw project root:

```bash
rm src/channels/emacs.ts src/channels/emacs.test.ts emacs/nanoclaw.el
# Remove the `import './emacs.js';` line from src/channels/index.ts
# Remove EMACS_* lines from .env
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
# systemctl --user restart $(systemd_unit)             # Linux

# Remove the NanoClaw block from your Emacs config
# Optionally clean up the messaging group:
pnpm exec tsx scripts/q.ts data/v2.db "DELETE FROM messaging_group_agents WHERE messaging_group_id IN (SELECT id FROM messaging_groups WHERE channel_type='emacs'); DELETE FROM messaging_groups WHERE channel_type='emacs';"
```
