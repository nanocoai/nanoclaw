---
name: add-whatsapp
description: Add WhatsApp channel via native Baileys adapter. Direct connection — no Chat SDK bridge. Uses QR code or pairing code for authentication.
---

# Add WhatsApp Channel

Adds WhatsApp support via the native Baileys adapter — a direct WhatsApp Web
connection, no Chat SDK bridge. NanoClaw doesn't ship channels in trunk — this
skill copies the WhatsApp adapter in from the `channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent
reads the prose and applies them, and a parser can apply them deterministically
from the same document. Every directive is idempotent, so the whole skill is
safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Number safety check (required)

Complete this check before running any install or authentication command. If
the user already said they want to use their **shared**, **personal**,
**main**, **existing**, or **everyday** WhatsApp number, treat it as a shared
number and show the warning immediately. Do not ask the number-type question
again.

Otherwise, ask which WhatsApp number NanoClaw will use:

```nc:prompt number_mode validate:^(dedicated|shared)$
Which WhatsApp number will NanoClaw use? `dedicated` (recommended) — a separate number used only for NanoClaw (spare SIM, eSIM, or old phone). `shared` — your existing everyday / personal WhatsApp number.
```

If the answer is `shared`, show this warning — tell the user:

```nc:operator when:number_mode=shared
⚠️ Risk to your WhatsApp account

Connecting your shared or personal number could cause WhatsApp to temporarily suspend or permanently ban that number. You could lose access to the WhatsApp account, chats, and groups you rely on.

We strongly recommend using a separate, dedicated number for NanoClaw.

On your personal number, the agent lives only in your "You" / self-chat. Messages other people send you are ignored entirely — never read, never answered, never flagged for approval. Nobody else can talk to the agent.

If you want the agent reachable as its own contact, consider:
• Telegram — a bot takes ~2 minutes to set up
• a dedicated WhatsApp number — spare SIM, eSIM, or old phone
• /add-whatsapp-cloud — the official Meta Business API
```

Then confirm how to proceed. Do not continue with installation or
authentication unless the user explicitly selects the second option:

```nc:prompt shared_confirm validate:^(continue|dedicated)$ when:number_mode=shared
How would you like to proceed? `dedicated` (recommended) — go back and use a dedicated number. `continue` — I understand the risk, continue with my shared number.
```

Remember the effective mode for the rest of this workflow: it is `shared` only
when the user explicitly acknowledged the risk and continued; anyone who chose
a dedicated number — up front or at the warning — continues as a
dedicated-number install without seeing the warning again:

```nc:run capture:mode effect:fetch when:number_mode=dedicated
echo dedicated
```
```nc:run capture:mode effect:fetch when:shared_confirm=continue
echo shared
```
```nc:run capture:mode effect:fetch when:shared_confirm=dedicated
echo dedicated
```

## Apply

### 1. Copy the adapter and its registration test

Fetch the `channels` branch and copy the WhatsApp adapter, its registration
test, and the `whatsapp-formatting` container skill (overwrite — the branch is
canonical). The `whatsapp-auth` setup step is maintained in trunk, so it is not
copied here:

```nc:copy from-branch:channels
src/channels/whatsapp.ts
src/channels/whatsapp-registration.test.ts
container/skills/whatsapp-formatting/SKILL.md
container/skills/whatsapp-formatting/instructions.md
```

The `whatsapp-formatting` container skill is part of the channel payload: its
`instructions.md` becomes the `skill-whatsapp-formatting.md` fragment in every
group's composed CLAUDE.md (see `src/claude-md-compose.ts`), teaching agents
WhatsApp's formatting syntax. Trunk does not ship it — without this copy step
agents format WhatsApp messages with generic markdown that renders literally.

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './whatsapp.js';
```

### 3. Install the adapter packages

Pinned to exact versions — the supply-chain policy rejects ranges and `latest`.
Baileys is the WhatsApp Web client; `qrcode` renders the device-link QR in the
terminal; `pino` is Baileys' logger:

```nc:dep
@whiskeysockets/baileys@7.0.0-rc.9
qrcode@1.5.4
@types/qrcode@1.5.6
pino@9.6.0
```

### 4. Build and validate

Build first: it typechecks the adapter against core and proves the dependencies
are installed. Then run the one integration test.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/whatsapp-registration.test.ts
```

`whatsapp-registration.test.ts` imports the real channel barrel and asserts the
registry contains `whatsapp`. It goes red if the `import './whatsapp.js';` line
is deleted or drifts, if the barrel fails to evaluate, or if
`@whiskeysockets/baileys` isn't installed (the import throws) — so it also covers
the dependency from step 3. End-to-end delivery against a real WhatsApp number is
verified manually once the service runs.

## Authenticate

WhatsApp uses linked-device authentication — no API key, just a one-time pairing
from your phone. The adapter is installed and registered, but its factory returns
`null` (and the channel stays dark) until `store/auth/creds.json` exists.

The number safety check above is still required even when credentials already
exist. If `store/auth/creds.json` exists, skip ahead to "Dedicated vs personal
number" after completing the safety check — the link step below reports the
already-linked number and moves on.

Pick how to link the device. `qr` shows a rotating QR you scan with your phone's
camera; `pairing-code` shows an 8-character code you type into WhatsApp (no camera
needed, but it needs your phone number):

```nc:prompt auth_method validate:^(qr|pairing-code)$
How do you want to link WhatsApp? Type `qr` to scan a QR code in this terminal, or `pairing-code` to enter a code on your phone (no camera needed).
```

The pairing-code method needs the number you're linking, the way WhatsApp expects
it — digits only, country code first, no `+`, spaces, or dashes (the QR method
skips this entirely):

```nc:prompt phone validate:^\d{8,15}$ when:auth_method=pairing-code
Your WhatsApp phone number — digits only, country code first (e.g. 14155551234 for +1 415-555-1234).
```

Point the user at the right screen before the code appears. For the QR method,
tell the user:

```nc:operator when:auth_method=qr
Link WhatsApp by QR:
1. On your phone, open WhatsApp → Settings → Linked Devices → Link a Device.
2. A QR code will appear in this terminal below and refresh every ~20 seconds. Point your phone's camera at it to scan.
```

For the pairing-code method, tell the user:

```nc:operator when:auth_method=pairing-code
Link WhatsApp by pairing code:
1. On your phone, open WhatsApp → Settings → Linked Devices → Link a Device → tap "Link with phone number instead".
2. An 8-character code will appear in this terminal below. Enter it on your phone immediately — it expires in about 60 seconds.
```

Now run the linked-device handshake. It streams the live QR (or the pairing-code
card) to this terminal and, on success, reports the linked WhatsApp number. Run
the command for the method chosen above — `qr` or `pairing-code`:

```nc:run effect:step capture:bot_phone=PHONE when:auth_method=qr
pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method qr
```
```nc:run effect:step capture:bot_phone=PHONE when:auth_method=pairing-code
pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone {{phone}}
```

If the handshake fails (`logged_out` or a timeout), the code expired — clear
`store/auth/` and run the step again for a fresh one. See Troubleshooting.

A successful link reports the number back as `bot_phone`. If it came back empty,
the device never confirmed (an expired QR or pairing code), so don't restart or
wire against a blank number — clear `store/auth/` and re-run the link step first:

```nc:run effect:check
[ -n "{{bot_phone}}" ]
```

## Your personal chat number (dedicated number only)

On a dedicated number, the agent owns the linked line and you chat with it from
your own, different number. Collect that number — it is required, and it is
*not* the number you just linked. Tell the user:

```nc:operator when:mode=dedicated
The agent is signed in as +{{bot_phone}}.

Now, your personal number — the one you'll chat with the agent from. It'll show up as a normal two-way conversation with the agent's contact.
```

```nc:prompt chat_phone validate:^\d{8,15}$ when:mode=dedicated
Your personal number, where you'll chat from — digits only, country code first (e.g. 14155551234). Required — this must be YOUR number, not the agent's linked one.
```

Chatting from the bot's own number IS the shared-number setup — if the number
given equals the linked number, stop and route through the same interception
screen as the up-front pick: show the account-risk warning from the number
safety check again and get explicit acknowledgement before treating this
install as shared (or collect a genuinely different personal number and stay
dedicated). If the install does become shared, correct the mode everywhere it
was recorded — in particular make sure `.env` ends up with
`ASSISTANT_HAS_OWN_NUMBER=false`, rewriting a `true` that may already have been
written; a stale `true` on a personal number makes the bot claim messages
addressed to the human:

```nc:run effect:check when:mode=dedicated
[ "{{chat_phone}}" != "{{bot_phone}}" ]
```

## Dedicated vs personal number

The adapter behaves fundamentally differently depending on whether the linked
number is the assistant's own or the operator's personal one. The switch is
`ASSISTANT_HAS_OWN_NUMBER` in `.env`, read by the adapter itself at startup.
**Inference rule: absent (or anything other than `true`) means shared/personal**
— the safe default, since misreading a personal number as dedicated makes the
bot claim messages addressed to the human.

- **Shared/personal number** (`ASSISTANT_HAS_OWN_NUMBER` unset or not `true`) — DMs to this number and group @-tags of it address the *human*, not the bot. The adapter never emits a mention signal (`mentions: 'never'` in its declared channel defaults), so: no stranger DM ever auto-creates a messaging group or raises an admin approval card; group wirings default to a name pattern (`\b<AgentName>\b`) instead of platform mentions; auto-created chats default to `unknown_sender_policy: 'strict'`; outbound messages are prefixed with the assistant's name.
- **Dedicated number** (`ASSISTANT_HAS_OWN_NUMBER=true`) — everything sent to the number is for the bot. DMs and group mentions carry a real mention signal (`mentions: 'platform'`), unknown senders escalate via `request_approval` approval cards, and card-approved groups wire with `engage_mode: 'mention'`. No name prefix on outbound.

Use the mode selected in the required safety check. If information discovered
later contradicts that selection, ask again before changing modes; switching to
shared requires the same warning and explicit acknowledgement.

Write the answer to `.env` **explicitly in both cases** (don't rely on the
inference rule for new installs), replacing any existing
`ASSISTANT_HAS_OWN_NUMBER` line. Written in both modes so a re-run that
switches dedicated → shared doesn't leave a stale `true` behind:

```nc:run effect:external when:mode=dedicated
grep -q '^ASSISTANT_HAS_OWN_NUMBER=' .env && sed -i.bak 's/^ASSISTANT_HAS_OWN_NUMBER=.*/ASSISTANT_HAS_OWN_NUMBER=true/' .env && rm -f .env.bak || echo 'ASSISTANT_HAS_OWN_NUMBER=true' >> .env
```
```nc:run effect:external when:mode=shared
grep -q '^ASSISTANT_HAS_OWN_NUMBER=' .env && sed -i.bak 's/^ASSISTANT_HAS_OWN_NUMBER=.*/ASSISTANT_HAS_OWN_NUMBER=false/' .env && rm -f .env.bak || echo 'ASSISTANT_HAS_OWN_NUMBER=false' >> .env
```

### Assistant name

Both modes: keep the adapter's outbound prefix / mention normalization in sync
with the chosen agent name (the adapter's config default is `Andy` otherwise).
Use the assistant's already-chosen name if one was configured; otherwise ask:

```nc:prompt agent_name normalize:trim validate:^.+$
What should your assistant be called? (e.g. `Nano` — used as the outbound name prefix on a shared number, and for @-name engagement)
```

Persist it to `.env` as `ASSISTANT_NAME`, replacing any existing
`ASSISTANT_NAME` line (the value is written literally — no pattern expansion):

```nc:run effect:external
touch .env && grep -v '^ASSISTANT_NAME=' .env > .env.tmp; printf 'ASSISTANT_NAME=%s\n' '{{agent_name}}' >> .env.tmp && mv .env.tmp .env
```

### Update path: existing install, flag unset

If WhatsApp auth already exists (`store/auth/creds.json` present) but `.env` has no `ASSISTANT_HAS_OWN_NUMBER` line, the install predates the explicit switch. Use the mode established by the required safety check and write it explicitly.

Suggest a default by comparing the authed number against the wired DM chat:

```bash
# The number this install is authenticated as
node -e "const c=JSON.parse(require('fs').readFileSync('store/auth/creds.json','utf-8'));console.log(c.me?.id?.split(':')[0])"
# The wired WhatsApp DM chats
pnpm exec tsx scripts/q.ts data/v2.db "SELECT mg.platform_id FROM messaging_groups mg JOIN messaging_group_agents mga ON mg.id=mga.messaging_group_id WHERE mg.channel_type='whatsapp' AND mg.is_group=0"
```

If the wired DM's phone **equals** the authed number, the operator is talking to the bot in their own self-chat — that's a personal number: suggest **Shared**. If they differ, the operator messages the bot from a different number: suggest **Dedicated**. Confirm with the operator either way, then write the flag and restart the service.

### Migration audit: spam-era group wirings

Before the shared-number fix, group chats approved via the channel-registration card were wired `engage_mode='pattern'` with pattern `.` — respond-to-everything — because the card flow couldn't tell groups from DMs on non-threaded platforms. On a personal number this shows up as the bot answering every message in family/work groups after someone once tapped Connect on a spam-triggered card.

List the suspect wirings (host service running — `ncl` is socket-only):

```bash
ncl wirings list --engage-mode pattern --engage-pattern "." --json
```

Cross-reference against WhatsApp group chats (`ncl messaging-groups list --channel-type whatsapp --is-group 1`). For each wiring with pattern `.` on a WhatsApp group that is *not* the operator's deliberate always-on chat (e.g. their self-chat), offer:

- **Flip to name-based engagement**: `ncl wirings update <wiring-id> --engage-mode pattern --engage-pattern '\b<AgentName>\b'` (or `--engage-mode mention` on a dedicated number)
- **Delete the wiring**: `ncl wirings delete <wiring-id>`

Stale approval cards from that era can also linger. Clear pending channel approvals for chats the operator doesn't want wired:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "DELETE FROM pending_channel_approvals WHERE messaging_group_id IN (SELECT id FROM messaging_groups WHERE channel_type='whatsapp')"
```

## Self-chat engagement (shared number only)

On a shared number the agent lives in your "You" / self-chat. Choose whether it
responds to every message you write there, or only to messages addressed to it
by name:

```nc:prompt selfchat_engage validate:^(all|mention)$ when:mode=shared
Respond to every self-chat message, or only messages starting with @<agent name>? `all` — every message (the self-chat becomes the agent's inbox). `mention` — only messages starting with @<agent name> (keep the self-chat for your own notes too).
```

For `mention`, the engage pattern is `@` plus the regex-escaped agent name,
anchored to the start of the message, with a trailing `\b` word-boundary guard.
`\b` only terminates a match after a word character — skip it for names ending
in punctuation, where it would never match:

```nc:run capture:engage_pattern effect:fetch when:selfchat_engage=mention
node -e 'const n=process.argv[1];const e=n.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");console.log(/\w$/.test(n)?"^@"+e+"\\b":"^@"+e)' '{{agent_name}}'
```

`engage_pattern` is what the self-chat wiring uses: when wiring this channel
with `scripts/init-first-agent.ts`, pass it as `--engage-pattern`. Choosing
`all` leaves it unset — the wiring falls back to the respond-to-everything
default for a DM.

## Restart

Restart NanoClaw so it loads the WhatsApp adapter and sees your credentials and
settings, and wait for its CLI socket before resolving. Restart only after
`ASSISTANT_HAS_OWN_NUMBER` / `ASSISTANT_NAME` land in `.env` — the adapter
computes its shared/dedicated mode and name once at module load, so restarting
earlier would leave it running with defaults:

```nc:run effect:restart
bash setup/lib/restart.sh
```

## Resolve your DM channel

Resolve the conversation address as the WhatsApp JID for the number you chat
from — the linked number itself for a shared account (your self-chat), or the
personal number you gave for a dedicated one. Run the one matching the mode:

```nc:run capture:platform_id effect:fetch when:mode=shared
echo "{{bot_phone}}@s.whatsapp.net"
```
```nc:run capture:platform_id effect:fetch when:mode=dedicated
echo "{{chat_phone}}@s.whatsapp.net"
```

For WhatsApp, your owner handle is that same JID:

```nc:run capture:owner_handle effect:fetch
echo "{{platform_id}}"
```

`owner_handle` and `platform_id` are what the owner-wiring step needs. The
greeting goes out over your WhatsApp chat as soon as the service reconnects with
the linked credentials.

## Next Steps

For a shared number, set expectations — tell the user:

```nc:operator when:mode=shared
Self-chat mode: only your "You" / self-chat is connected. Messages other people send to your number are ignored — never seen, never asked about. The welcome message will land in your "You" chat on WhatsApp.

Wire a specific chat later with /manage-channels.
```

If you're in the middle of `/setup`, return to the setup flow now. Otherwise wire
this channel with `/init-first-agent` (or `/manage-channels`) — in shared
`mention` mode, pass the engage pattern above via `--engage-pattern`.

## Channel Info

- **type**: `whatsapp`
- **terminology**: WhatsApp calls them "groups" and "chats." A "chat" is a 1:1 DM; a "group" has multiple members.
- **platform-id-format**: DMs use `<phone>@s.whatsapp.net` (e.g. `14155551234@s.whatsapp.net`). Groups use `<id>@g.us`. Native adapter — the JID is the platform ID as-is, no `whatsapp:` prefix.
- **how-to-find-id**: To find your linked number after auth: `node -e "const c=JSON.parse(require('fs').readFileSync('store/auth/creds.json','utf-8'));console.log(c.me?.id?.split(':')[0].split('@')[0]+'@s.whatsapp.net')"`. Groups are auto-discovered — check `pnpm exec tsx scripts/q.ts data/v2.db "SELECT platform_id, name FROM messaging_groups WHERE channel_type='whatsapp' AND is_group=1"`.
- **supports-threads**: no
- **typical-use**: Interactive chat — direct messages or small groups
- **default-isolation**: Same agent group if you're the only participant across multiple chats. Separate agent group if different people are in different groups.

### Features

- Markdown formatting — `**bold**`→`*bold*`, `*italic*`→`_italic_`, headings→bold, code blocks preserved
- Approval questions — `ask_user_question` renders with `/approve`, `/reject` slash commands
- File attachments — send and receive images, video, audio, documents
- Reactions — send emoji reactions on messages
- Typing indicators — composing presence updates
- Credential requests — text fallback (WhatsApp has no modal support)

Not supported (WhatsApp linked-device limitation): edit messages, delete messages.

## Alternatives

### QR code in a browser

Besides the in-terminal QR and the pairing code the Apply flow uses, this skill
ships a helper that renders the rotating QR as a PNG in your default browser —
handy when the terminal QR is too small to scan reliably. It spawns the same
`whatsapp-auth` step, parses each rotating QR from its `WHATSAPP_AUTH_QR` status
blocks, and serves the current one on a local HTTP server (default port `8765`,
falls back to a free port):

```bash
pnpm exec tsx .claude/skills/add-whatsapp/scripts/wa-qr-browser.ts
```

Flags: `--clean` wipes `store/auth/` before spawning, `--port N` pins the port.

A browser window opens with a QR code. On your phone, open WhatsApp →
**Settings** → **Linked Devices** → **Link a Device**, scan the QR, and the page
shows "Authenticated!" when done.

### Headless environments

On a headless host (no display server — no `$DISPLAY`/`$WAYLAND_DISPLAY`, not
macOS), the browser method can't open a window. Detect it and fall back to the
pairing-code method (no camera needed):

```bash
[[ -z "$DISPLAY" && -z "$WAYLAND_DISPLAY" && "$OSTYPE" != darwin* ]] && echo "IS_HEADLESS=true" || echo "IS_HEADLESS=false"
```

## Optional configuration

If the assistant runs on a dedicated number (its own phone/SIM, not your personal
WhatsApp), tell the adapter so it doesn't prefix outbound replies with its name:

```bash
ASSISTANT_HAS_OWN_NUMBER=true
```

The Apply flow writes this key for you **in both modes** — `true` for a
dedicated number, `false` for a shared (personal) one — so a re-run that
switches modes never leaves a stale value behind. Absent (or anything other
than `true`) is read as shared/personal, the safe default.

## Troubleshooting

### QR code or pairing code expired

Codes expire after ~60 seconds. The QR rotates automatically while the auth step
is running; if the step exited, clear the auth state and re-run it:

```bash
rm -rf store/auth/ && pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method qr
```

For pairing code, ensure digits only (no `+`), the phone has internet, and
WhatsApp is updated:

```bash
rm -rf store/auth/ && pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone <phone>
```

WhatsApp's pairing-code flow occasionally rejects valid codes with "Couldn't link
device." This is a server-side rejection unrelated to the code itself. If you hit
it more than once, switch to the QR method — it has a noticeably higher success
rate.

### Pairing code not working

Codes expire in ~60 seconds. Delete auth and retry:

```bash
rm -rf store/auth/ && pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone <phone>
```

Ensure: digits only (no `+`), phone has internet, WhatsApp is updated.

WhatsApp's pairing-code flow occasionally rejects valid codes with "Couldn't link
device — An error happened. Please try again." This is a server-side rejection
unrelated to the code itself; we've seen it happen twice in a row on fresh
dedicated numbers. If you hit it more than once, switch to QR-browser auth — it
has a noticeably higher success rate:

```bash
pnpm exec tsx .claude/skills/add-whatsapp/scripts/wa-qr-browser.ts --clean
```

### "waiting for this message" on reactions

WhatsApp sessions corrupted from rapid restarts. Clear sessions, then restart the
service. Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
systemctl --user stop $(systemd_unit)
rm store/auth/session-*.json
systemctl --user start $(systemd_unit)
```

### Bot not responding

1. Auth exists: `test -f store/auth/creds.json`
2. Connected: `grep "Connected to WhatsApp" logs/nanoclaw.log | tail -1`
3. Channel wired: `pnpm exec tsx scripts/q.ts data/v2.db "SELECT mg.platform_id, mg.name FROM messaging_groups mg JOIN messaging_group_agents mga ON mg.id=mga.messaging_group_id WHERE mg.channel_type='whatsapp'"`
4. Service running: `systemctl --user status "$(. setup/lib/install-slug.sh && systemd_unit)"`

### "conflict" disconnection

Two instances connected with the same credentials. Ensure only one NanoClaw
process is running.

### Trunk updated but shared-number behavior unchanged (stale adapter copy)

The shared-number behavior (no stranger approval cards, name-pattern group defaults) lives in the **adapter copy** at `src/channels/whatsapp.ts`, installed from the `channels` branch — not in trunk. If you updated trunk via `/update-nanoclaw` but skipped the skill-update step, the old adapter copy neither reads `ASSISTANT_HAS_OWN_NUMBER` itself nor declares channel defaults, so trunk falls back to the legacy behavior: approval cards still fire on a personal number, and new wirings get the channel-blind defaults. Symptoms of the skew:

- `.env` says `ASSISTANT_HAS_OWN_NUMBER=false` (or unset) but strangers' DMs still raise approval cards
- `ncl wirings create` on a WhatsApp group defaults to `mention` instead of a name pattern

Fix: re-run `/add-whatsapp` (or `/update-skills`) to pull the current adapter from the `channels` branch, then restart the service. The reverse skew (new adapter, old trunk) can't happen — the adapter's `defaults` field is optional and old trunk ignores it.
