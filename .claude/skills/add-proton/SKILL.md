---
name: add-proton
description: Add Proton privacy suite MCP server — Mail (IMAP/SMTP), Pass (credential vault + TOTP), Calendar (CalDAV via Radicale workaround), Drive (blocked), VPN status. 36 tools for container agents via Proton Bridge.
---

# Add Proton Suite MCP Server

MCP server exposing 36 tools from the Proton privacy ecosystem to NanoClaw V2 container agents. Agents can send/receive email, manage credentials, create calendar events, and check VPN status — all through Proton Bridge.

**Battle-tested:** Production-proven since March 2026. Daily email operations and credential lookups.

**Honest status:** Mail and Pass work reliably. Calendar works via a local Radicale workaround (not native Proton Calendar sync). Drive is blocked by Proton's rclone backend issues. VPN is read-only status checks.

## Current state (April 2026)

| Module | Status | Notes |
|--------|--------|-------|
| **Mail** | Working | Full IMAP/SMTP via Proton Bridge. Send, receive, reply in-thread, search, attachments. |
| **Pass** | Working | Credential vault, TOTP codes, Hide My Email aliases via pass-cli. |
| **Calendar** | Workaround | See "Calendar: The Proton Problem" below. |
| **Drive** | Blocked | rclone's protondrive backend has auth issues with Proton's SRP. See below. |
| **VPN** | Read-only | Status checks work. Connect/disconnect requires system-level access. |

## Calendar: The Proton Problem

Proton Calendar has no public API and no CalDAV endpoint. Proton Bridge only exposes IMAP/SMTP (email) — it does not bridge calendar data. This means there is no supported way for an external tool to read or write Proton Calendar events.

### What we tried

1. **Direct Proton API** — Proton uses SRP (Secure Remote Password) authentication, not OAuth or API keys. Their servers actively flag automated traffic with anti-abuse error 2028. We hit this wall and opened support ticket #4655421, which went through 3 rounds of tier-1 canned responses with no resolution. A GitHub issue on ProtonMail/WebClients#424 shows at least 3 other developers hit the same block. Proton's position is that programmatic access outside their official apps is unsupported.

2. **protond (Proton signing daemon)** — We spec'd a local daemon that would handle SRP auth and proxy API calls. Full spec written, implementation started, then abandoned when Proton's anti-abuse system made it clear they would flag any automated auth regardless of implementation quality. The spec is preserved at `tools/protond/` for future reference.

3. **CalDAV bridge** — Proton doesn't expose CalDAV. Period. No bridge, no proxy, no workaround at the protocol level.

### The working workaround: Radicale → DAVx5 → Etar

Instead of fighting Proton, we route through an open-source CalDAV stack:

```
NanoClaw agent
  → calendar__create_event (CalDAV to Radicale on localhost:5232)
    → Radicale (lightweight CalDAV server, Python, self-hosted)
      → DAVx5 (Android CalDAV sync app, syncs to Radicale)
        → Etar (open-source Android calendar app, reads from DAVx5)
```

**What this gives you:**
- Agent can create, read, update, delete events via standard CalDAV
- Events appear on your Android phone within the DAVx5 sync interval (typically 15 min, configurable to 5 min)
- Etar displays them alongside any other calendars

**What this doesn't give you:**
- No sync TO Proton Calendar (events live in Radicale, not Proton)
- No reading FROM Proton Calendar (agent can't see events created in the Proton app)
- Two calendars to manage (Proton for personal, Radicale for agent-created)

**Setup:**
```bash
# Install Radicale
pip install radicale
mkdir -p ~/.config/radicale

cat > ~/.config/radicale/config << 'EOF'
[server]
hosts = 127.0.0.1:5232

[auth]
type = htpasswd
htpasswd_filename = ~/.config/radicale/users
htpasswd_encryption = plain

[storage]
filesystem_folder = ~/.local/share/radicale/collections
EOF

echo "nanoclaw:nanoclaw" > ~/.config/radicale/users
python -m radicale
```

On your Android phone:
1. Install **DAVx5** (F-Droid or Play Store)
2. Add account → CalDAV, URL: `http://YOUR_HOST_IP:5232/nanoclaw/`
3. Install **Etar** (F-Droid) → it reads from DAVx5 automatically

### Future: If Proton opens up

If Proton ever ships a public API or CalDAV bridge, the `calendar__*` tools can be rewired to hit Proton directly. The MCP tool interface stays the same — only the backend client changes. We're watching ProtonMail/WebClients for any movement.

## Drive: Why it's blocked

rclone's `protondrive` backend requires Proton API authentication, which uses SRP. The same anti-abuse flag (error 2028) that blocks calendar also blocks Drive. rclone maintainers are aware but can't fix a server-side policy.

**Workaround:** Use Proton Drive's official desktop app for sync. The agent can read/write files in the synced local folder instead of going through the API. Not wired up in this skill yet — contributions welcome.

## Tools (36 total)

### Mail (IMAP + SMTP via Proton Bridge) — WORKING
- `mail__list_folders`, `mail__list_messages`, `mail__get_message`
- `mail__get_unread`, `mail__search_messages`
- `mail__send_message`, `mail__reply_message`, `mail__forward_message`
- `mail__mark_read`, `mail__move_message`, `mail__delete_message`

### Pass (Proton Pass CLI) — WORKING
- `pass__list_vaults`, `pass__list_items`, `pass__get_item`
- `pass__search_items`, `pass__create_login`, `pass__create_note`
- `pass__get_totp`, `pass__create_alias`

### Calendar (CalDAV → Radicale) — WORKAROUND
- `calendar__list_calendars`, `calendar__list_events`, `calendar__get_event`
- `calendar__create_event`, `calendar__update_event`, `calendar__delete_event`

### Drive (rclone + protondrive) — BLOCKED
- `drive__list_files`, `drive__read_file`, `drive__write_file`
- `drive__delete_file`, `drive__mkdir`, `drive__get_about`

### VPN — READ-ONLY
- `vpn__status`, `vpn__list_servers`, `vpn__connect`, `vpn__disconnect`

## Prerequisites

### 1. Proton Bridge (required for Mail)

Install [Proton Bridge](https://proton.me/mail/bridge), log in, note the IMAP/SMTP ports and bridge password. Set up as a systemd service with socat relays for Docker access (see install section).

### 2. Proton Pass CLI (for Pass tools)

```bash
# Download from https://proton.me/pass/download
pass-cli --version
```

### 3. Radicale (for Calendar workaround)

```bash
pip install radicale
```

## Install

### Phase 1: Pre-flight

```bash
test -d tools/proton-mcp && echo "Already installed" || echo "Ready to install"
```

### Phase 2: Apply

```bash
git fetch origin skill/proton-mcp
git checkout origin/skill/proton-mcp -- tools/proton-mcp/ .claude/skills/add-proton/
cd tools/proton-mcp && npm install && cd ../..
```

Add the MCP server to your agent group's `groups/<folder>/container.json`:

```json
{
  "mcpServers": {
    "proton": {
      "command": "node",
      "args": ["/workspace/extra/proton-mcp/index.js"],
      "env": {
        "PROTON_BRIDGE_IMAP_HOST": "172.17.0.1",
        "PROTON_BRIDGE_IMAP_PORT": "1143",
        "PROTON_BRIDGE_SMTP_HOST": "172.17.0.1",
        "PROTON_BRIDGE_SMTP_PORT": "1025",
        "PROTON_BRIDGE_USERNAME": "your-address@proton.me",
        "PROTON_BRIDGE_PASSWORD": "your-bridge-password",
        "PROTON_PASS_BIN": "/workspace/extra/pass-cli-bin/pass-cli"
      }
    }
  },
  "additionalMounts": [
    {
      "hostPath": "~/NanoClaw/tools/proton-mcp",
      "containerPath": "proton-mcp",
      "readonly": true
    },
    {
      "hostPath": "~/.local/bin/pass-cli",
      "containerPath": "pass-cli-bin/pass-cli",
      "readonly": true
    }
  ]
}
```

Add mount allowlist entries (`~/.config/nanoclaw/mount-allowlist.json`):

```json
{
  "allowedRoots": [
    { "path": "/home/YOU/NanoClaw/tools", "allowReadWrite": false },
    { "path": "/home/YOU/.local/bin", "allowReadWrite": false }
  ]
}
```

### Proton Bridge systemd service (with Docker socat relay)

```bash
cat > ~/.config/systemd/user/proton-bridge.service << 'EOF'
[Unit]
Description=Proton Bridge
After=network.target

[Service]
ExecStartPre=-/usr/bin/pkill -f 'socat.*172.17.0.1.*(1025|1143)'
ExecStart=/usr/bin/protonmail-bridge --noninteractive
ExecStartPost=/bin/bash -c 'sleep 2 && socat TCP-LISTEN:1143,bind=172.17.0.1,fork,reuseaddr TCP:127.0.0.1:1143 & socat TCP-LISTEN:1025,bind=172.17.0.1,fork,reuseaddr TCP:127.0.0.1:1025 &'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now proton-bridge
```

### Phase 3: Restart

```bash
systemctl --user restart nanoclaw
```

## Verify

Ask the agent: "List my unread emails" or "What's in my NanoClaw vault?"

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| SMTP sends silently fail | Stale socat relay after Bridge restart | Restart Bridge service (socat auto-restarts) |
| `401 Invalid access token` | Bridge session expired | `protonmail-bridge --cli` → logout → login |
| `pass-cli ENOENT` | Binary not mounted in container | Add to additionalMounts + mount allowlist |
| Calendar events don't appear in Proton | Expected — Radicale is local only | Use DAVx5 + Etar on phone instead |
| `drive__*` tools fail | rclone protondrive backend blocked by Proton | No fix available — use Proton Drive desktop app |
| Mount rejected | Path not in allowlist | Add to `~/.config/nanoclaw/mount-allowlist.json` |

## Removal

```bash
rm -rf tools/proton-mcp
# Remove proton config from groups/*/container.json
systemctl --user restart nanoclaw
```
