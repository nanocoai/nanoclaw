---
name: add-mac-control
description: Add Mac Control to NanoClaw — lets the agent run shell commands, AppleScript, and system actions (restart, sleep, lock) on Macs on the local network. Supports multiple Macs identified by name.
---

# Add Mac Control

This skill installs a host bridge on each Mac and wires it into NanoClaw so the agent can control Macs over the LAN.

## Architecture

- **Host bridge** (`host-bridge/bridge.js`): a small HTTP server running as a launchd service on each Mac. Accepts HMAC-signed requests and executes commands on the host.
- **Container skill** (`container/skills/mac-control/SKILL.md`): teaches the agent how to call the bridge.
- **`host-bridge/mac-hosts.json`**: maps Mac names (e.g. `personal`, `work`) to their LAN IPs.
- **`BRIDGE_SECRET`**: a shared HMAC secret in `.env`, injected into containers by `container-runner.ts`.

## Prerequisite: Same Wi-Fi Network

**All MacBooks must be connected to the same Wi-Fi network.** The host bridge communicates over LAN — if the Macs are on different networks (e.g. one on home Wi-Fi, one on a mobile hotspot, or different VLANs), they cannot reach each other.

Before proceeding, confirm with the user:

AskUserQuestion: "Are all the MacBooks you want to control connected to the same Wi-Fi network?"
- header: "Network check"
- multiSelect: false
- options:
  - "Yes, same Wi-Fi" (description: "All Macs are on the same local network")
  - "No / Not sure" (description: "I need to check or move some Macs")

If "No / Not sure": tell the user to connect all Macs to the same Wi-Fi before continuing. They can verify by running `ipconfig getifaddr en0` on each Mac — the IPs should share the same prefix (e.g. all `192.168.1.x`).

## Phase 1: Pre-flight

Check if already installed:

```bash
ls host-bridge/bridge.js 2>/dev/null && echo "EXISTS" || echo "NOT FOUND"
```

If EXISTS, skip to Phase 3 (fixed IP setup).

## Phase 2: Merge the skill branch

Fetch and merge the `skill/mac-control` branch. This brings in the host bridge, container skill, and container-runner changes.

```bash
git fetch origin skill/mac-control
git merge origin/skill/mac-control --no-edit
```

If the merge has conflicts with `package-lock.json`, resolve by keeping theirs:
```bash
git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue
```

Verify the files arrived:
```bash
ls host-bridge/bridge.js host-bridge/install.sh host-bridge/mac-hosts-example.json container/skills/mac-control/SKILL.md
```

## Phase 3: Set a fixed IP on each Mac

DHCP can reassign IPs at any time, which would break the bridge. Each Mac needs a fixed IP.

Tell the user:

> **On each Mac you want to control (including this one), set a fixed IP address:**
>
> 1. Open **System Settings** > **Wi-Fi**
> 2. Click **Details...** next to your connected Wi-Fi network
> 3. Go to **TCP/IP**
> 4. Set **Configure IPv4** to **"Using DHCP with Manual Address"**
> 5. Enter your desired IP address (e.g. `192.168.1.175`)
>
> Pick an IP that's high enough to avoid DHCP conflicts (e.g. `.150`+). Use the same IP you'll put in `mac-hosts.json`.

AskUserQuestion: "Have you set a fixed IP on each Mac?"
- header: "Fixed IP"
- multiSelect: false
- options:
  - "Yes, all Macs have fixed IPs" (description: "I set them in System Settings > Wi-Fi > TCP/IP")
  - "I need help choosing IPs" (description: "Help me pick non-conflicting IPs")

If "I need help": get their current IP with `ipconfig getifaddr en0`, suggest using that same IP as the fixed address (it's already working). For additional Macs, suggest incrementing by 1 (e.g. `.175`, `.176`, `.177`).

**If bridge files already existed in Phase 1 (EXISTS):** skip to Phase 5 — the files below are already in place.

## Phase 4: Create `host-bridge/mac-hosts.json`

See `host-bridge/mac-hosts-example.json` for the expected format.

AskUserQuestion: "How many Macs do you want to control?"
- header: "Mac count"
- multiSelect: false
- options:
  - "1 — just this Mac" (description: "Only the Mac running NanoClaw")
  - "2 Macs" (description: "e.g. personal + work")
  - "3 Macs" (description: "e.g. personal + work + media server")

Then, for each Mac, AskUserQuestion: "What should Mac #N be called? This is the name you'll use when talking to Nanoclaw (e.g. 'run uptime on personal')."
- header: "Mac name"
- multiSelect: false
- options:
  - "personal" (description: "Your main/personal Mac")
  - "work" (description: "Your work Mac")
  - "server" (description: "A Mac used as a server")

The first Mac is always the one running NanoClaw. Get its LAN IP automatically:

```bash
ipconfig getifaddr en0
```

For additional Macs, AskUserQuestion: "What is the LAN IP of your <mac-name> Mac? Find it on that Mac with: ipconfig getifaddr en0"
- header: "LAN IP"
- Allow the user to type a custom response (the IP address)

Copy `host-bridge/mac-hosts-example.json` to `host-bridge/mac-hosts.json` and fill in the user's Mac names and LAN IPs.

**Important:** Always use LAN IPs (e.g. `192.168.1.x`), never `127.0.0.1` or `host.docker.internal`. Both resolve incorrectly from inside Docker containers.

After `mac-hosts.json` is created, delete the example file and add `mac-hosts.json` to `.gitignore` (it contains LAN IPs and should not be committed):

```bash
rm host-bridge/mac-hosts-example.json
echo "host-bridge/mac-hosts.json" >> .gitignore
```

## Phase 5: Update global CLAUDE.md

Add the following bullet to `groups/global/CLAUDE.md` under "What You Can Do":

```
- **Control Macs** on the local network with `mac-control` skill — run shell commands, AppleScript, system actions (restart, sleep, lock) on personal or work MacBook
```

## Phase 6: Generate secret and add to .env

```bash
SECRET=$(openssl rand -hex 32)
echo "" >> .env
echo "BRIDGE_SECRET=$SECRET" >> .env
```

Verify the value has no quotes around it:
```bash
grep BRIDGE_SECRET .env
```

If the value has quotes, strip them:
```bash
sed -i '' 's/^BRIDGE_SECRET="\(.*\)"$/BRIDGE_SECRET=\1/' .env
```

## Phase 7: Sync env and install bridge on the main Mac

Sync `.env` to container data dir first (so the container can read BRIDGE_SECRET):
```bash
cp .env data/env/env
```

Then install the bridge:
```bash
bash host-bridge/install.sh "<BRIDGE_SECRET value>"
```

Verify the bridge is running:
```bash
launchctl list | grep nanoclaw.bridge
```

If not running, check `~/Library/NanoClaw/host-bridge/bridge.error.log`.

## Phase 8: Build, restart, and verify the main Mac bridge

```bash
npm run build
cp .env data/env/env
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Verify both services are running:
```bash
launchctl list | grep nanoclaw
# Should show: com.nanoclaw.bridge + com.nanoclaw
```

**Verification gate — do not proceed until this passes.** Test the bridge from the host using the LAN IP (not 127.0.0.1):

```bash
export LAN_IP=$(ipconfig getifaddr en0)
export BRIDGE_SECRET=$(grep BRIDGE_SECRET .env | cut -d= -f2)
node - <<'EOF'
const crypto=require('crypto'),http=require('http');
const body=JSON.stringify({type:'system',action:'uptime'});
const sig=crypto.createHmac('sha256',process.env.BRIDGE_SECRET).update(body).digest('hex');
const req=http.request({hostname:process.env.LAN_IP,port:3737,path:'/run',method:'POST',
  headers:{'Content-Type':'application/json','X-Bridge-Signature':sig,'Content-Length':Buffer.byteLength(body)}},
  res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>console.log(d));});
req.on('error',e=>console.error(e.message));req.write(body);req.end();
EOF
```

Expected: `{"ok":true,"stdout":"...uptime...","stderr":""}`

If this fails:
- `"Invalid signature"` → BRIDGE_SECRET has quotes or whitespace. Check `.env` and re-run `install.sh` with the correct value.
- `"ECONNREFUSED"` → Bridge not listening. Check `launchctl list | grep nanoclaw.bridge` and restart.

AskUserQuestion: "The bridge on this Mac is working. Ready to set up additional Macs?"
- header: "Next step"
- multiSelect: false
- options:
  - "Yes, set up additional Macs" (description: "I'll guide you through installing the bridge on each one")
  - "No additional Macs" (description: "Only controlling this Mac — skip to verification")

If no additional Macs → skip to Phase 10.

## Phase 9: Install bridge on additional Macs

For each additional Mac listed in `mac-hosts.json`:

Tell the user:

> **On your <mac-name> Mac, you need to do 2 things:**
>
> 1. Copy `host-bridge/bridge.js` and `host-bridge/install.sh` to that Mac (AirDrop, USB, iMessage — any method)
> 2. Open Terminal on that Mac, `cd` to the folder where you copied the files, and run:
>    ```bash
>    bash install.sh "<BRIDGE_SECRET value>"
>    ```
>
> When it succeeds you'll see:
> ```
> ✓ Host bridge running on port 3737
> Find your LAN IP: ipconfig getifaddr en0
> ```
>
> That's it — the bridge auto-starts on login.

AskUserQuestion: "Have you installed the bridge on your <mac-name> Mac?"
- header: "Remote setup"
- multiSelect: false
- options:
  - "Yes, it's running" (description: "I ran install.sh and it showed the success message")
  - "Need help" (description: "Something went wrong during installation")

If "Need help": ask for the error message and troubleshoot.

After confirmation, verify the remote bridge is reachable from this Mac:

```bash
export BRIDGE_SECRET=$(grep BRIDGE_SECRET .env | cut -d= -f2)
export REMOTE_IP="<ip-from-mac-hosts.json>"
node - <<'EOF'
const crypto=require('crypto'),http=require('http');
const body=JSON.stringify({type:'system',action:'hostname'});
const sig=crypto.createHmac('sha256',process.env.BRIDGE_SECRET).update(body).digest('hex');
const req=http.request({hostname:process.env.REMOTE_IP,port:3737,path:'/run',method:'POST',timeout:5000,
  headers:{'Content-Type':'application/json','X-Bridge-Signature':sig,'Content-Length':Buffer.byteLength(body)}},
  res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>console.log(d));});
req.on('error',e=>console.error(e.message));req.write(body);req.end();
EOF
```

Expected: `{"ok":true,"stdout":"<work-mac-hostname>","stderr":""}`

If this fails:
- Both Macs must be on the same WiFi network
- Check the IP is correct: the user should run `ipconfig getifaddr en0` on the remote Mac
- Update `mac-hosts.json` if the IP was wrong, then re-test (no rebuild needed)

Repeat for each additional Mac.

## Phase 10: Final verification

Tell the user to test via WhatsApp/chat. Suggest a message like "run uptime on personal" or "run hostname on work".

AskUserQuestion: "Did Nanoclaw successfully run the command?"
- header: "Verify"
- multiSelect: false
- options:
  - "Yes, it works!" (description: "Setup complete")
  - "No, there's an error" (description: "I'll help troubleshoot")

If error, ask the user to share Nanoclaw's response and check the troubleshooting section below.

## Troubleshooting

**"Invalid signature"** — BRIDGE_SECRET in the plist doesn't match `.env`. Re-run `install.sh` with the correct secret.

**"connection refused"** — Bridge not running. On that Mac: `launchctl list | grep nanoclaw.bridge`. If missing, re-run `install.sh`.

**"ECONNREFUSED / EHOSTUNREACH" from inside container** — Using `127.0.0.1` instead of LAN IP. Fix `mac-hosts.json` to use the real LAN IP.

**Bridge stopped after reboot** — plist permissions wrong. Run: `chmod 644 ~/Library/LaunchAgents/com.nanoclaw.bridge.plist` then re-bootstrap.
```bash
launchctl bootout gui/$(id -u)/com.nanoclaw.bridge 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.bridge.plist
```
