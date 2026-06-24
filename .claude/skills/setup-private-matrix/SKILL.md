---
name: setup-private-matrix
description: Set up a fully private, end-to-end-encrypted Matrix channel for THIS NanoClaw install — a self-hosted Synapse homeserver on this machine, reached privately from your phone over Tailscale (no third-party servers), with Element X as the client. Automates Tailscale + Synapse + Tailscale Serve (HTTPS) + accounts + wiring + verification. Triggers on "set up private matrix", "matrix e2ee", "self-hosted matrix", "private encrypted bot channel".
---

# Set up a private, self-hosted, E2E-encrypted Matrix channel

This skill gives this NanoClaw bot a Matrix channel where **nothing leaves this machine except the model API call**: the homeserver runs locally in Docker, and your phone reaches it over your **own private Tailscale network**. No Telegram/Signal/Matrix.org third party ever sees your traffic.

**This is a standalone, personal setup.** Everything below is keyed to *this* user's own accounts, tailnet, homeserver, and bot. It does not connect to or share anything with anyone else's NanoClaw install.

## Before you start — tell the operator they need
- **macOS or Linux** with this NanoClaw install already running (the host service is up, and at least one agent group exists — if not, run `/init-first-agent` first).
  - **Windows is not supported.** The NanoClaw host, the backup script, and the Docker bind-mount all assume a POSIX environment. If the operator is on Windows, tell them to use **WSL2 (Ubuntu)** and follow the Linux path — the instructions work verbatim inside WSL2.
- **Docker** installed and running:
  - macOS: Docker Desktop
  - Linux: Docker Engine (`sudo apt install docker.io` / `sudo dnf install docker` + `sudo systemctl enable --now docker`, then add your user to the `docker` group: `sudo usermod -aG docker $USER` and log out/in)
- A **smartphone** with the **Element X** app installable (Play Store / App Store).
- A **personal email** (e.g. a personal Gmail) for Tailscale sign-in — see the critical note in Step 1.
- ~30 minutes; several steps need the operator to tap things on their machine and phone.

## Self-contained — this skill bundles both patches
You do NOT need the `/add-matrix` skill or any upstream merge. This skill folder carries everything in `assets/`:
- **`assets/channels/`** — the **native-crypto** Matrix adapter (`matrix.ts` + tests). This replaces the legacy WASM/Chat-SDK adapter, which **cannot persist E2E keys in Node** and will not work.
- **`assets/docs/`** — the adapter's E2EE doc.
- **`assets/patches/`** — the **`matrix-bot-sdk` cross-signing patch** (so the bot can verify its own device → no red "unverified" shield in Element). If a `matrix-bot-sdk@*.patch` file is present here, Step 5 applies it; if only the README placeholder is present, the setup still works but the bot device stays "unverified" (red shield — encryption is unaffected; see Limitations).

Both the **adapter patch** (the native adapter itself) and the **SDK patch** (cross-signing) are installed by Step 5 below.

---

# Execution playbook (you, the assistant, run this end-to-end)

Work through these in order. Steps marked **[OPERATOR]** require the human; do them as guided hand-offs and wait. Steps marked **[YOU]** you run via tools. Discover all install-specific values dynamically — never hardcode.

**Detect the platform first** — set `$PLATFORM` and use it throughout:
```bash
PLATFORM=$(uname -s)   # Darwin = macOS, Linux = Linux
echo "Platform: $PLATFORM"
```

## Step 1 — Tailscale (private network) [OPERATOR + YOU]
Tailscale is how the phone reaches this machine's homeserver privately, from anywhere, with no public exposure.

**[OPERATOR] Install + sign in on BOTH the host machine and phone:**

macOS:
1. `brew install --cask tailscale` (or download from https://tailscale.com/download/mac). Open it and **Sign in**.

Linux:
1. `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`

Both:
2. **CRITICAL — sign in with a PERSONAL email (e.g. personal Gmail), NOT a company/Workspace email.** A personal email gives a free, single-user tailnet. A Google **Workspace**/custom-domain email makes Tailscale treat you as a business org → it charges ($8/user/mo) AND may not include Tailnet Lock. Personal email = free + private + solo.
3. Phone: install the **Tailscale** app, sign in with the **same** personal email.
4. In the Tailscale admin console (https://login.tailscale.com/admin/dns): confirm **MagicDNS is enabled**, and **enable "HTTPS Certificates"** (this is required so Element X gets a valid TLS endpoint later — it's free).

**[YOU] Verify and capture the machine's MagicDNS name:**
```bash
# tailscale CLI is on PATH on Linux; on macOS Homebrew also puts it on PATH,
# but the cask app exposes it at /Applications/Tailscale.app/Contents/MacOS/Tailscale if not.
tailscale status   # confirm this machine AND the phone show as connected, same account
tailscale status --json | python3 -c "import sys,json;d=json.load(sys.stdin);s=d['Self'];print('MAGICDNS=',s['DNSName'].rstrip('.'))"
```
Save the MagicDNS name (e.g. `mac.tailXXXX.ts.net`) as `HS` (homeserver name) for the rest of the run. Tip: the operator can rename the machine to something short (e.g. `mac`) in the admin console for cleaner Matrix IDs.

## Step 2 — Provision the cert (confirms HTTPS works) [YOU]
```bash
cd /tmp && tailscale cert "$HS"   # should write $HS.crt and $HS.key
rm -f "/tmp/$HS.crt" "/tmp/$HS.key"
```
If it errors "does not support getting TLS certs", the operator hasn't enabled **HTTPS Certificates** (Step 1.4) — have them do it, then retry.

## Step 3 — Self-hosted Synapse homeserver (Docker) [YOU]
Generate the config with `server_name` = the **MagicDNS name** (NOT `localhost` — `localhost` can't be reached from the phone). Bind to localhost only; Tailscale Serve will be the HTTPS front door.
```bash
mkdir -p ~/synapse-data
docker run --rm -v ~/synapse-data:/data \
  -e SYNAPSE_SERVER_NAME="$HS" -e SYNAPSE_REPORT_STATS=no \
  matrixdotorg/synapse:latest generate
# add public_baseurl
grep -q '^public_baseurl:' ~/synapse-data/homeserver.yaml || \
  printf '\npublic_baseurl: "https://%s/"\n' "$HS" >> ~/synapse-data/homeserver.yaml
# the generated 8008 listener already has x_forwarded:true and client+federation resources — good for a reverse proxy
docker run -d --name synapse --restart unless-stopped \
  -v ~/synapse-data:/data -p 127.0.0.1:8008:8008 matrixdotorg/synapse:latest
# wait for health
for i in $(seq 1 30); do c=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8008/_matrix/client/versions); [ "$c" = 200 ] && break; sleep 2; done; echo "synapse http $c"
```

## Step 4 — Tailscale Serve = HTTPS front for Synapse [YOU]
Element X requires HTTPS. Tailscale Serve terminates TLS (auto Let's Encrypt cert for the `.ts.net` name) and proxies to Synapse — **tailnet-only, never public**.
```bash
tailscale serve --bg --https=443 http://127.0.0.1:8008
tailscale serve status
curl -s -o /dev/null -w "https GET -> %{http_code} (verify %{ssl_verify_result})\n" "https://$HS/_matrix/client/versions"  # want 200, verify 0
```

## Step 5 — Install the native adapter + apply the SDK cross-signing patch [YOU]
Everything comes from this skill's `assets/`. Let `SKILL_DIR=.claude/skills/setup-private-matrix`.

**5a. Install the native adapter (the "adapter patch"):**
```bash
cp "$SKILL_DIR"/assets/channels/matrix.ts                 src/channels/matrix.ts
cp "$SKILL_DIR"/assets/channels/matrix.test.ts            src/channels/matrix.test.ts
cp "$SKILL_DIR"/assets/channels/matrix-registration.test.ts src/channels/ 2>/dev/null || true
mkdir -p docs && cp "$SKILL_DIR"/assets/docs/matrix-e2ee-native.md docs/ 2>/dev/null || true
# self-registration import
grep -q "import './matrix.js'" src/channels/index.ts || printf "\nimport './matrix.js';\n" >> src/channels/index.ts
# remove the legacy WASM adapter dep if present, add the native stack (pinned)
pnpm remove @beeper/chat-adapter-matrix 2>/dev/null || true
pnpm add matrix-bot-sdk@0.8.0
# the native crypto binding has an install build script → must be allowlisted (supply-chain policy)
grep -q '@matrix-org/matrix-sdk-crypto-nodejs' pnpm-workspace.yaml || \
  printf "\nonlyBuiltDependencies:\n  - '@matrix-org/matrix-sdk-crypto-nodejs'\n" >> pnpm-workspace.yaml
```
> If `onlyBuiltDependencies` already exists in `pnpm-workspace.yaml`, add the entry under it instead of appending a second block. The native binary is a prebuilt download — no Rust toolchain needed.

**5b. Apply the `matrix-bot-sdk` cross-signing patch (the "SDK patch"):**
```bash
PATCH=$(ls "$SKILL_DIR"/assets/patches/matrix-bot-sdk@*.patch 2>/dev/null | head -1)
if [ -n "$PATCH" ]; then
  mkdir -p patches && cp "$PATCH" "patches/$(basename "$PATCH")"
fi
```
Then register it under **`pnpm-workspace.yaml`** (this repo's pnpm config — NOT `package.json`). Add (create the `patchedDependencies:` key if it doesn't exist; merge the line in if it does):
```yaml
patchedDependencies:
  matrix-bot-sdk@0.8.0: patches/matrix-bot-sdk@0.8.0.patch
```
The patch is **safe and idempotent** — applying it never breaks anything even if the runtime gate below isn't met (the adapter just logs a WARN and continues with full E2E).

**5c. Enable green-shield cross-signing — Node 24 + binding ≥ 0.5.0 (proven; do this for green).** Cross-signing only *publishes* when the crypto binding `@matrix-org/matrix-sdk-crypto-nodejs` is **≥ 0.5.0** (0.4.0 silently discards the upload requests), and that binding's engine requires **Node ≥ 24**. Both are needed; set them up:
```bash
# (a) force the binding to a cross-signing-capable version (0.6.1 also fixes a crypto-lib CVE)
if grep -q "^overrides:" pnpm-workspace.yaml; then
  echo ">> merge this line under the existing 'overrides:' key in pnpm-workspace.yaml:"
  echo "     '@matrix-org/matrix-sdk-crypto-nodejs': 0.6.1"
else
  printf "\noverrides:\n  '@matrix-org/matrix-sdk-crypto-nodejs': 0.6.1\n" >> pnpm-workspace.yaml
fi
# (b) the host MUST run Node >= 24
node -v
# if < 24: install via nvm (`nvm install 24`), then repoint the service launcher:
#   macOS:  update the node path in the launchd plist (Program or PATH env var)
#   Linux:  update the ExecStart path in the systemd unit, or set Environment=PATH=...
# then run `pnpm rebuild` to recompile native modules for the new ABI.
```
> **Staying on Node 22 / binding 0.4.0 is fine** (skip 5c): everything still works — fully private, persistent E2E — the bot device just shows a **red "unverified" shield**, which is cosmetic for a bot you own. Green-shield is the only thing that needs the Node 24 + override.

**5d. Install, rebuild native modules, build:**
```bash
pnpm install
pnpm rebuild      # REQUIRED whenever the Node major version changed — recompiles better-sqlite3 etc.
                  # for the new ABI. Skipping this after a Node bump breaks the DB (tests/host fail).
pnpm run build
pnpm test 2>&1 | tail -5   # adapter + cross-signing patch tests should pass
```
With Node ≥ 24 + the override + the patch + `MATRIX_RECOVERY_KEY` (Step 7), the bot bootstraps and self-signs its device on first start → **no red shield**. (Note: `matrix-bot-sdk` can't drive *interactive* device verification, so don't expect the emoji/SAS "verify user" flow to complete — it isn't needed; the device being owner-cross-signed is what removes the red.)

## Step 6 — Create the bot + operator Matrix accounts [YOU]
Strong random passwords; never reuse a placeholder.
```bash
BOTPW=$(openssl rand -hex 18); MEPW=$(openssl rand -hex 18)
docker exec synapse register_new_matrix_user -u nanoclawbot -p "$BOTPW" --no-admin -c /data/homeserver.yaml http://localhost:8008
# ask the operator for the username they want for THEMSELVES (e.g. their first name); default below
ME=me   # replace with operator's chosen handle
docker exec synapse register_new_matrix_user -u "$ME" -p "$MEPW" --no-admin -c /data/homeserver.yaml http://localhost:8008
```
**Tell the operator their own login**: username `@$ME:$HS`, password `$MEPW` (they'll use it in Element X). Save the bot password for `.env`.

## Step 7 — Configure `.env` [YOU]
The bot connects to Synapse over localhost. `MATRIX_DEVICE_ID` keeps the device stable across restarts; `MATRIX_RECOVERY_KEY` drives cross-signing, 4S key backup, and Synapse backup encryption.

> **MATRIX_RECOVERY_KEY — write this down.** This value serves as the single recovery passphrase for everything: it derives the SSSS key that protects the bot's cross-signing private keys in Matrix account data, and it encrypts the age private key that decrypts your Synapse backups. If the machine is lost and you don't have this value, you cannot recover. Store it in a password manager or somewhere permanently safe — not only in `.env`.

The operator may supply their own strong passphrase instead of generating one. If they already have one, use it; otherwise generate:
```bash
cd <repo root>
RECKEY=$(openssl rand -hex 32)
echo "MATRIX_RECOVERY_KEY = $RECKEY  ← store this in your password manager NOW"
cat >> .env <<EOF
MATRIX_BASE_URL=http://127.0.0.1:8008
MATRIX_USERNAME=nanoclawbot
MATRIX_PASSWORD=$BOTPW
MATRIX_DEVICE_ID=NANOCLAW01
MATRIX_RECOVERY_KEY=$RECKEY
MATRIX_INVITE_AUTOJOIN=true
EOF
# do NOT set MATRIX_USER_ID alongside MATRIX_USERNAME — it causes a double login / token war
mkdir -p data/env && cp .env data/env/env   # sync to container mount
```

## Step 8 — Wire the Matrix DM to the operator's agent group [YOU]
For a 1:1 DM the adapter maps the platform id to `matrix:@<operator>:<HS>` (predictable — so you can pre-wire). Discover the agent group dynamically; don't hardcode.
```bash
AG=$(sqlite3 data/v2.db "SELECT id FROM agent_groups ORDER BY created_at LIMIT 1;")   # or ask which agent group
PLAT="matrix:@$ME:$HS"; USERID="matrix:@$ME:$HS"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z"); MGID="mg-matrix-$(date +%s)"; MGAID="mga-$(openssl rand -hex 8)"
sqlite3 data/v2.db "INSERT OR IGNORE INTO users (id,kind,display_name,created_at) VALUES ('$USERID','matrix',NULL,'$NOW');"
sqlite3 data/v2.db "INSERT OR IGNORE INTO messaging_groups (id,channel_type,platform_id,instance,name,is_group,unknown_sender_policy,created_at) VALUES ('$MGID','matrix','$PLAT','matrix','Matrix DM',0,'request_approval','$NOW');"
MG=$(sqlite3 data/v2.db "SELECT id FROM messaging_groups WHERE channel_type='matrix' AND platform_id='$PLAT' AND instance='matrix';")
sqlite3 data/v2.db "INSERT OR IGNORE INTO messaging_group_agents (id,messaging_group_id,agent_group_id,session_mode,priority,created_at,engage_mode,engage_pattern,sender_scope,ignored_message_policy) VALUES ('$MGAID','$MG','$AG','shared',0,'$NOW','pattern','.','all','drop');"
sqlite3 data/v2.db "INSERT OR REPLACE INTO user_roles (user_id,role,agent_group_id,granted_by,granted_at) VALUES ('$USERID','owner',NULL,'system','$NOW');"
sqlite3 data/v2.db "INSERT OR IGNORE INTO agent_group_members (user_id,agent_group_id,added_by,added_at) VALUES ('$USERID','$AG','system','$NOW');"
```
Note: `messaging_groups.instance` is `NOT NULL` and equals the channel type (`matrix`). `engage_pattern='.'` = always-reply (right for a personal DM). `v2.db` is WAL mode — short writes are fine; **never run a `pkill` whose pattern matches your own running command.**

## Step 9 — Restart the host [OPERATOR confirms] [YOU]
Get explicit confirmation before restarting (it briefly interrupts the running assistant).

macOS:
```bash
LABEL=$(launchctl list | grep -i nanoclaw | awk '{print $3}' | head -1)
launchctl kickstart -k "gui/$(id -u)/$LABEL"
```

Linux:
```bash
systemctl --user restart nanoclaw
```

Then verify:
```bash
sleep 16
grep -E "Matrix channel connected|Matrix: crypto ready|NanoClaw running" logs/nanoclaw.log | tail -3
```
Expect `Matrix: crypto ready` (with a device id) and `Matrix channel connected`. A WARN that `MATRIX_RECOVERY_KEY` can't bootstrap cross-signing is expected (see Limitations).

## Step 10 — Element X on the phone [OPERATOR]
Tell the operator, precisely:
1. **Make sure Tailscale is connected on the phone** (or `$HS` won't resolve).
2. Open **Element X** → sign in. When it offers **matrix.org, DO NOT use it** — choose "Change account provider"/"Other" and enter **your** homeserver: `$HS`. Then log in as `@$ME:$HS` with the password from Step 6.
3. **Start chat** (a DM — NOT "Create room") with `@nanoclawbot:$HS`. It likely won't appear in search; use "add by matrix ID" / send to the exact ID.
4. Send a message (e.g. "hi").

## Step 11 — Verify [YOU]
```bash
# round-trip:
awk '/^\[/' logs/nanoclaw.log | grep -iE "Matrix message received|Message routed|Matrix message sent|Message delivered" | tail -5
# persistence (the core promise) — restart and confirm SAME device id + 'reusing existing crypto store':
```

macOS:
```bash
launchctl kickstart -k "gui/$(id -u)/$LABEL"
```
Linux:
```bash
systemctl --user restart nanoclaw
```

```bash
sleep 16
grep -iE "reusing existing crypto store|crypto ready" logs/nanoclaw.log | tail -2   # same device id as before = pass
```
Have the operator send another message after the restart and confirm the bot still replies and history still decrypts.

---

# The "unverified device" red shield — and how the SDK patch removes it
- **Without the SDK cross-signing patch** (Step 5b skipped / no patch bundled): the bot's replies show a **red shield** ("Encrypted by a device not verified by its owner"). This is **harmless** — messages ARE end-to-end encrypted; red only means the bot's device has no cross-signed identity (stock `matrix-bot-sdk` can't cross-sign). Treat it as "unverified-but-mine."
- **With the SDK patch + `MATRIX_RECOVERY_KEY` (Step 7) + the runtime gate met** (binding ≥ 0.5.0 on **Node ≥ 24** — Step 5c): on startup the bot bootstraps a cross-signing identity and **self-signs its device**, which removes the red "unverified by its owner" warning. *Proven working.* If anything is missing (old binding, no patch, no password, UIA failure) it logs a WARN and continues — never crashing the message flow. **On Node 22 / binding 0.4.0 it no-ops and the shield stays red — a fully-working, fully-encrypted state.**
  - Note: `matrix-bot-sdk` does **not** drive *interactive* verification (emoji/SAS), so the Element "verify this user" flow won't complete — and it isn't needed. The red is removed by the bot self-signing its device (above); any residual neutral "not verified by you" indicator is benign for a bot you own.

# Troubleshooting (things that bite)
- **Element X went to matrix.org / "can't find server"** → it must point at `$HS`; phone Tailscale must be on; check `$HS` spelling.
- **"does not support getting TLS certs"** → enable HTTPS Certificates in the Tailscale admin (Step 1.4).
- **Bot connects but messages never arrive / no `Matrix message received`** → confirm it's an **encrypted DM** (not a room), and that the host log shows `Matrix: crypto ready`. Check the message isn't in a stale earlier DM.
- **`M_UNKNOWN_TOKEN` / stale session** (e.g. if the homeserver was regenerated) → the native adapter persists its token at `data/v2-matrix-store.json` and crypto at `data/v2-matrix-crypto/`. To force a clean re-login, stop the host and `rm -f data/v2-matrix-store.json` (token only). Only delete `data/v2-matrix-crypto/` as a last resort — that wipes the device identity and forces re-keying (new device). Keep `MATRIX_USER_ID` unset alongside `MATRIX_USERNAME`.
- **Reachable only at home** → that's expected; the homeserver is local. Tailscale gives anywhere-access *as long as the phone's Tailscale is connected*.
- **DB write seems stuck** → it's WAL; another writer (the host) may hold a brief lock — retry; never `pkill` a pattern matching your own command.
- **Linux: Docker permission denied** → the user isn't in the `docker` group yet. Run `sudo usermod -aG docker $USER`, log out and back in, then retry.
- **Linux: `tailscale` command not found after install** → run `sudo tailscale up` once to bring up the daemon, then `tailscale status`.

## Step 12 — Off-machine encrypted backup [YOU]

The Synapse database and the nanoclaw crypto store both live on this machine. A disk failure with no off-machine backup would lose them both simultaneously — 4S can't help because the SSSS blobs are also on the same machine. This step ships a daily encrypted backup to a cloud storage provider via rclone.

**Design:**
- Encryption: `age` key pair. The public key encrypts backups non-interactively (no TTY needed in scheduled jobs). The private key is backed up to cloud storage, itself encrypted with `openssl AES-256-CBC + MATRIX_RECOVERY_KEY` — so the single recovery passphrase unlocks everything.
- SQLite is snapshotted online (`.backup` command — WAL-safe, no Synapse downtime).
- 14 daily backups retained (~2 weeks). Oldest pruned automatically.

**12a. Install tools:**

macOS:
```bash
brew install age rclone
```

Linux (Debian/Ubuntu):
```bash
sudo apt install -y age rclone
# if age is not in apt (Ubuntu < 22.04): download from https://github.com/FiloSottile/age/releases
# if rclone is not in apt or is outdated: curl https://rclone.org/install.sh | sudo bash
```

Linux (RHEL/Fedora):
```bash
sudo dnf install -y age rclone
# if age is not in dnf: download from https://github.com/FiloSottile/age/releases
```

**12b. Generate age key pair:**
```bash
mkdir -p ~/.config/nanoclaw
age-keygen -o ~/.config/nanoclaw/backup-age-key
chmod 600 ~/.config/nanoclaw/backup-age-key
AGE_PUBKEY=$(grep 'public key:' ~/.config/nanoclaw/backup-age-key | awk '{print $NF}')
echo "Public key: $AGE_PUBKEY"
```
Save `$AGE_PUBKEY` — you'll write it into the backup script below.

**12c. Encrypt the private key with the recovery passphrase (recovery anchor):**
```bash
RECOVERY_KEY=$(grep '^MATRIX_RECOVERY_KEY=' .env | cut -d= -f2-)
echo "$RECOVERY_KEY" | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 \
  -pass stdin -in ~/.config/nanoclaw/backup-age-key \
  -out ~/.config/nanoclaw/backup-age-key.enc
```

**12d. Configure rclone for your cloud storage provider:**

The operator must do this once interactively (browser OAuth). Have them open a new terminal and run:
```
rclone config
```
Walk them through: `n` → new remote → name it (e.g. `gdrive`) → storage type (e.g. `drive` for Google Drive) → blank client_id/secret → scope `1` (full access) → `y` to open browser → approve → `n` (not shared drive) → `y` confirm.

After they confirm it's done, verify:
```bash
rclone lsd <remote>:   # e.g. rclone lsd gdrive:
```

Set these for the steps below:
```bash
RCLONE_REMOTE_NAME="gdrive"          # the remote name chosen above
RCLONE_DEST="$RCLONE_REMOTE_NAME:nanoclaw-backups"
```

**12e. Deploy the backup script:**

The repo already ships `scripts/backup-synapse.sh`. Update the two install-specific values at the top:
```bash
NANOCLAW_DIR="$(pwd)"
sed -i.bak \
  -e "s|^AGE_PUBLIC_KEY=.*|AGE_PUBLIC_KEY=\"$AGE_PUBKEY\"|" \
  -e "s|gdrive:nanoclaw-backups/synapse|$RCLONE_DEST/synapse|" \
  scripts/backup-synapse.sh && rm scripts/backup-synapse.sh.bak
chmod +x scripts/backup-synapse.sh
```

**12f. Schedule the daily backup:**

macOS (launchd):
```bash
cat > ~/Library/LaunchAgents/com.nanoclaw.backup-synapse.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw.backup-synapse</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$(pwd)/scripts/backup-synapse.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key><integer>3</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>$(pwd)/logs/backup-synapse.log</string>
    <key>StandardErrorPath</key>
    <string>$(pwd)/logs/backup-synapse.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/com.nanoclaw.backup-synapse.plist
```

Linux (systemd user timer):
```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/nanoclaw-backup-synapse.service << EOF
[Unit]
Description=NanoClaw Synapse backup

[Service]
Type=oneshot
ExecStart=/bin/bash $(pwd)/scripts/backup-synapse.sh
Environment=PATH=/usr/local/bin:/usr/bin:/bin
StandardOutput=append:$(pwd)/logs/backup-synapse.log
StandardError=append:$(pwd)/logs/backup-synapse.log
EOF

cat > ~/.config/systemd/user/nanoclaw-backup-synapse.timer << EOF
[Unit]
Description=NanoClaw Synapse backup — daily at 03:00

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now nanoclaw-backup-synapse.timer
systemctl --user list-timers nanoclaw-backup-synapse.timer
```

> **Linux note:** `Persistent=true` means if the machine was off at 03:00, the backup runs at next boot. Requires `loginctl enable-linger $USER` if you want the timer to fire when no user session is active (e.g. a headless server).

**12g. Upload the recovery key anchor and run the first backup:**

Tell the operator to run these two commands themselves (or they can approve them in this session):
```bash
rclone copy ~/.config/nanoclaw/backup-age-key.enc "$RCLONE_DEST/"
bash scripts/backup-synapse.sh
```
Check `logs/backup-synapse.log` for `=== Backup complete ===`.

**Recovery procedure (if the machine is lost):**
```bash
# 1. Install rclone + age on the new machine, configure the same rclone remote
# 2. Download the encrypted private key
rclone copy <remote>:nanoclaw-backups/backup-age-key.enc .
# 3. Decrypt the private key
echo "YOUR_MATRIX_RECOVERY_KEY" | openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -pass stdin -in backup-age-key.enc -out backup-age-key
# 4. List available backups
rclone lsf <remote>:nanoclaw-backups/synapse/
# 5. Download and decrypt the latest backup
rclone copy <remote>:nanoclaw-backups/synapse/synapse-YYYYMMDD-HHMMSS.tar.gz.age .
age --decrypt -i backup-age-key synapse-YYYYMMDD-HHMMSS.tar.gz.age | tar -xzf -
```

# Safety notes for you (the assistant running this)
- Confirm with the operator before restarting the host service.
- Use strong random passwords; print the operator's own login to them once, and keep the bot password only in `.env`.
- Everything stays on this machine + the operator's tailnet — do not expose Synapse publicly (no port-forwarding, no ngrok, no `tailscale funnel`).
