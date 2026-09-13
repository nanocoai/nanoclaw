---
name: add-proton-mail
description: Add Proton Mail as a channel via a local Proton Mail Bridge — native IMAP/SMTP adapter, no Chat SDK bridge. Builds Bridge from source in Docker so it runs on arm64 (Raspberry Pi) as well as x86. Agents receive mail as messages and reply by email. Requires a paid Proton plan.
---

# Add Proton Mail Channel

Adds Proton Mail as a channel: incoming mail to your Proton address wakes the
agent as an inbound message, and the agent's reply goes back out as email,
threaded onto the sender's message. NanoClaw doesn't ship channels in trunk —
this skill copies the adapter in from the `channels` branch.

Proton encrypts mail end-to-end, so there is no IMAP server to connect to
directly. **Proton Mail Bridge** runs on this machine, holds the account's keys,
and exposes ordinary IMAP/SMTP on loopback. Proton only ships Bridge binaries for
x86; this skill builds it from source inside Docker, which works on arm64
(Raspberry Pi 4/5) and x86 alike. The host process is the only thing that talks
to Bridge — its ports are published on `127.0.0.1` only, never to containers or
the network.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent
reads the prose and applies them, and a parser can apply them deterministically
from the same document. Every directive is idempotent, so the whole skill is
safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Prerequisites (required)

**Bridge only works on a paid Proton plan** — Mail Plus, Proton Unlimited,
Proton Family/Duo, or Proton for Business. Proton Free accounts cannot sign in
to Bridge at all. Confirm this before building anything; if the user is on Free,
stop here and tell them so — nothing below will work.

```nc:prompt plan_ok validate:^yes$ flags:i normalize:lower
Proton Mail Bridge requires a paid Proton plan (Mail Plus, Unlimited, Family/Duo, or Business) — it cannot sign in to a Proton Free account. Type `yes` to confirm you have a paid plan. If you're on Proton Free, stop here: this channel won't work.
```

```nc:run effect:check
[ "{{plan_ok}}" = "yes" ]
```

Bridge runs as a Docker container, so Docker must be installed and the current
user able to run it (NanoClaw's own agent containers already need this):

```nc:run effect:check
docker info >/dev/null 2>&1
```

## Apply

### 1. Copy the adapter and its tests

Fetch the `channels` branch and copy the Proton Mail adapter, its registration
test, and its unit tests (overwrite — the branch is canonical). The Bridge
container files (`bridge/Dockerfile`, `bridge/entrypoint.sh`, `bridge/gpgparams`)
ship in this skill's own directory and are used in place:

```nc:copy from-branch:channels
src/channels/proton-mail.ts
src/channels/proton-mail-registration.test.ts
src/channels/proton-mail.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './proton-mail.js';
```

### 3. Install the adapter packages

Pinned to exact versions — the supply-chain policy rejects ranges and `latest`.
`imapflow` is the IMAP client (IDLE-capable), `mailparser` turns raw RFC 822
into text/attachments, `nodemailer` sends over SMTP:

```nc:dep
imapflow@1.7.8
mailparser@3.9.20
nodemailer@9.1.1
@types/mailparser@3.4.6
@types/nodemailer@8.0.1
```

### 4. Build and validate

Build first: it typechecks the adapter against core and proves the dependencies
are installed. Then run the integration test and the adapter's unit tests.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/proton-mail-registration.test.ts src/channels/proton-mail.test.ts
```

`proton-mail-registration.test.ts` imports the real channel barrel and asserts
the registry contains `proton-mail`. It goes red if the `import './proton-mail.js';`
line is deleted or drifts, if the barrel fails to evaluate, or if any of the mail
packages isn't installed (the import throws) — so it also covers the dependencies
from step 3. End-to-end delivery against a real Proton account is verified once
the service runs (below).

## Build Proton Mail Bridge

Build the Bridge image from the pinned upstream release. This compiles Go from
source and takes **15–30 minutes on a Raspberry Pi** (a few minutes on x86);
re-runs are cached and return immediately. The version is pinned in the
Dockerfile's `BRIDGE_VERSION` argument:

```nc:run effect:external
docker build -t nanoclaw-proton-bridge:latest .claude/skills/add-proton-mail/bridge
```

Bridge stores the account login in a `pass` keyring inside the container. It
lives in a named Docker volume, `nanoclaw-proton-bridge`, so it survives
container and image replacement. The login itself is interactive (Proton asks
for the account password, a 2FA code if enabled, and the mailbox password on
two-password accounts), so it has to run in a real terminal. Tell the user:

```nc:operator
Sign the Bridge in to your Proton account. In a real terminal (SSH session or local shell — the login needs a TTY):

    docker run --rm -it -v nanoclaw-proton-bridge:/root nanoclaw-proton-bridge:latest init

At the `>>>` prompt:
  1. Type `login` and follow the prompts (Proton username, password, 2FA code if you use one, mailbox password on two-password accounts).
  2. Wait for "Account <you> was added successfully" — the first sync can take a minute.
  3. Type `exit`.

Nothing to copy: the bridge password is read from Bridge's vault in the next step.
```

Bridge authenticates IMAP/SMTP with a **bridge password** — a random string it
generates, not the Proton account password. Read it straight from the vault with
the `vault-editor` tool built alongside Bridge, so it is never transcribed by
hand (the displayed form is the vault's raw bytes as unpadded base64, which is
what the `sed` reproduces). The Proton account password is never stored anywhere
in NanoClaw:

```nc:run effect:fetch capture:bridge_password validate:^[A-Za-z0-9+/_-]{20,}$
docker run --rm -v nanoclaw-proton-bridge:/root --entrypoint /protonmail/vault-editor nanoclaw-proton-bridge:latest read | grep -o '"BridgePass": *"[^"]*"' | head -1 | sed 's/.*: *"//; s/"$//; s/=*$//'
```

The account's primary address is in the vault too. Read it, then confirm which
address the agent should send from — the primary, or any alias on the same
account (all aliases share one inbox and one bridge password):

```nc:run effect:fetch capture:primary_email validate:^[^@\s]+@[^@\s]+\.[^@\s]+$
docker run --rm -v nanoclaw-proton-bridge:/root --entrypoint /protonmail/vault-editor nanoclaw-proton-bridge:latest read | grep -o '"PrimaryEmail": *"[^"]*"' | head -1 | sed 's/.*: *"//; s/"$//' | tr 'A-Z' 'a-z'
```

```nc:prompt proton_address normalize:lower validate:^[^@\s]+@[^@\s]+\.[^@\s]+$
Which address should the agent use? Bridge signed in as `{{primary_email}}` — press through with that, or give an alias on the same Proton account (e.g. `assistant@proton.me`) to send from instead.
```

Write both to `.env` (set-if-absent; edit `.env` directly to rotate them later):

```nc:env-set
PROTON_MAIL_ADDRESS={{proton_address}}
PROTON_MAIL_BRIDGE_PASSWORD={{bridge_password}}
```

## Run Bridge

Start Bridge as a long-lived container. Its IMAP (1143) and SMTP (1025) ports are
published on `127.0.0.1` only — anyone who can reach them with the bridge
password can read the whole mailbox, so they must never be exposed on `0.0.0.0`.
`--restart unless-stopped` brings it back across reboots. Re-running replaces
the container in place (the login lives in the volume, not the container):

```nc:run effect:external
docker rm -f nanoclaw-proton-bridge >/dev/null 2>&1; docker run -d --name nanoclaw-proton-bridge --restart unless-stopped -p 127.0.0.1:1025:2025 -p 127.0.0.1:1143:2143 -v nanoclaw-proton-bridge:/root nanoclaw-proton-bridge:latest
```

Bridge takes a few seconds to load the vault and open its listeners. Wait for
the IMAP greeting (`* OK`) before restarting NanoClaw — a bare TCP connect is
not enough, since the container's forwarder accepts connections before Bridge
itself is listening. An adapter that connects early would only retry, but a
failed check here points straight at Bridge rather than at the adapter:

```nc:run effect:check
for i in $(seq 1 30); do timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/1143; head -c 64 <&3' 2>/dev/null | grep -q '^\* OK' && exit 0; sleep 2; done; docker logs --tail 20 nanoclaw-proton-bridge; exit 1
```

## Restart

Restart NanoClaw so it loads the Proton Mail adapter and sees the credentials,
and wait for its CLI socket before resolving:

```nc:run effect:restart
bash setup/lib/restart.sh
```

After the restart, `logs/nanoclaw.log` should show `Proton Mail adapter connected`.

## Resolve your DM channel

Email has no "self-chat": you write to the agent's Proton address from a
different address of your own, and the agent replies there. That address is
both the conversation id and your owner handle. Collect it:

```nc:prompt owner_email normalize:lower validate:^[^@\s]+@[^@\s]+\.[^@\s]+$
Your own email address — the one you'll write to the agent from (any provider). Not the agent's Proton address.
```

```nc:run capture:platform_id effect:fetch
echo "{{owner_email}}"
```
```nc:run capture:owner_handle effect:fetch
echo "{{platform_id}}"
```

`owner_handle` and `platform_id` are what the owner-wiring step needs. The
welcome message goes out as an email to that address as soon as the wiring
exists.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise wire
this channel with `/init-first-agent` (or `/manage-channels`).

Tell the user what to expect:

```nc:operator
Proton Mail is connected as {{proton_address}}. Send it an email from {{owner_email}} and the agent replies in the same thread.

Mail from anyone else is held for your approval the first time they write (unknown_sender_policy: request_approval) — nothing reaches the agent until you approve the sender. Bounces, auto-replies and the agent's own mail are filtered out automatically.
```

## Channel Info

- **type**: `proton-mail`
- **terminology**: Email has correspondents, not chats or groups. Each sender address is its own conversation.
- **platform-id-format**: the correspondent's address, lowercased, as-is — `someone@example.com`. Native adapter — no `proton-mail:` prefix. User ids are `proton-mail:someone@example.com`.
- **how-to-find-id**: It's the sender's email address. Auto-discovered on first mail — check `pnpm exec tsx scripts/q.ts data/v2.db "SELECT platform_id, name FROM messaging_groups WHERE channel_type='proton-mail'"`.
- **supports-threads**: no — one session per correspondent. Replies are threaded in the correspondent's mail client via `In-Reply-To`/`References`.
- **typical-use**: Email in, email out. Forward a document for summary; email the agent a question; let it send scheduled reports.
- **default-isolation**: One agent group per Proton address is the natural unit. Multiple correspondents share the agent but get separate sessions.

### Features

- Inbound: subject + body (quoted reply history stripped), attachments saved to the session inbox (up to 15 MB each), HTML-only mail flattened to text
- Outbound: plain-text replies, `Re:` subject, threaded onto the correspondent's last mail; file attachments from the session outbox
- Approval questions — `ask_user_question` renders as a mail with `/approve`-style slash commands; reply with the command on the first line
- Loop safety — the agent's own mail carries an `X-NanoClaw-Agent` header and is never re-ingested; `Auto-Submitted`, `Precedence: bulk`, `mailer-daemon`/`noreply` senders are dropped
- Live delivery via IMAP IDLE, with a 60 s fallback poll

Not supported: reactions, typing indicators, edit/delete, groups/mailing-list semantics (a CC'd thread is still one conversation per sender).

## Optional configuration

All `.env` keys the adapter reads. Only the first two are required.

```bash
PROTON_MAIL_ADDRESS=assistant@proton.me     # Bridge account
PROTON_MAIL_BRIDGE_PASSWORD=...             # from `info` in the Bridge CLI
PROTON_MAIL_FROM_NAME=Nano                  # display name on outbound mail
PROTON_MAIL_IMAP_HOST=127.0.0.1             # Bridge IMAP (default 127.0.0.1:1143)
PROTON_MAIL_IMAP_PORT=1143
PROTON_MAIL_SMTP_HOST=127.0.0.1             # Bridge SMTP (default 127.0.0.1:1025)
PROTON_MAIL_SMTP_PORT=1025
PROTON_MAIL_TLS_REJECT_UNAUTHORIZED=false   # Bridge uses a self-signed cert on loopback
PROTON_MAIL_MAILBOX=INBOX                   # folder to watch
PROTON_MAIL_POLL_SECONDS=60                 # fallback poll behind IDLE
PROTON_MAIL_MARK_SEEN=true                  # mark ingested mail read in Proton
PROTON_MAIL_PROCESS_BACKLOG=false           # true: ingest existing mail on first start
PROTON_MAIL_DEFAULT_SUBJECT=Message from your assistant   # for agent-initiated mail with no thread
```

On first connect the adapter records the mailbox's current position and only
processes mail that arrives afterwards; set `PROTON_MAIL_PROCESS_BACKLOG=true`
(and delete `store/proton-mail/state.json`) to ingest what's already there.

### Upgrading Bridge

Bump `BRIDGE_VERSION` in `.claude/skills/add-proton-mail/bridge/Dockerfile` to a
newer [upstream release](https://github.com/ProtonMail/proton-bridge/releases),
then re-run the **Build** and **Run Bridge** steps. The login in the volume
carries over.

## Troubleshooting

### `login` fails or asks for something unexpected

- **"Invalid credentials" on a correct password** — the account is on Proton Free, or the password has a leading/trailing space. Bridge needs a paid plan.
- **Two-password mode** — Bridge asks for the mailbox password after the account password. Both are needed.
- **2FA** — enter the TOTP code from your authenticator when prompted. Passkey/FIDO2 sign-in works if the hardware key is passed to the container; TOTP is simpler.
- **Captcha / "human verification"** — Proton sometimes demands a browser captcha for a new device. Sign in once at mail.proton.me from the same network, then retry `login`.

### Adapter logs `IMAP connect failed` / `ECONNREFUSED`

Bridge isn't listening. `docker ps --filter name=nanoclaw-proton-bridge` should
show it running; `docker logs nanoclaw-proton-bridge` shows why not. Common
cause: the container was started before `init` completed, so the vault is empty
— finish `login`, then re-run the **Run Bridge** step.

### Adapter logs `IMAP connect failed … Command failed`; Bridge log says `no such user`

`PROTON_MAIL_BRIDGE_PASSWORD` doesn't match. Bridge's `no such user` is its
answer to *any* credential mismatch, not just an unknown address. The bridge
password is a 22-character unpadded-base64 string; a hand-copied value with a
stray character is the usual cause. Re-derive it from the vault rather than
retyping (this is what the install step does):

```bash
docker run --rm -v nanoclaw-proton-bridge:/root --entrypoint /protonmail/vault-editor nanoclaw-proton-bridge:latest read | grep -o '"BridgePass": *"[^"]*"' | head -1 | sed 's/.*: *"//; s/"$//; s/=*$//'
```

Put that value on the `PROTON_MAIL_BRIDGE_PASSWORD=` line in `.env` and
restart. Bridge regenerates the password if you `delete` and re-add the account,
so repeat this after any re-login. Bridge also rate-limits after a few failures
(`too many login attempts`); the adapter's backoff rides that out on its own.

### Mail arrives in Proton but the agent never wakes

1. Adapter connected: `grep "Proton Mail adapter connected" logs/nanoclaw.log | tail -1`
2. Sender wired or approved: `pnpm exec tsx scripts/q.ts data/v2.db "SELECT platform_id, unknown_sender_policy, denied_at FROM messaging_groups WHERE channel_type='proton-mail'"` — a first-time sender is held for approval; check `ncl approvals list`.
3. Not filtered: the adapter drops `Auto-Submitted`, `Precedence: bulk/junk`, and `noreply@`/`mailer-daemon@` senders (`logs/nanoclaw.log` at debug: `Proton Mail inbound skipped`).
4. Right folder: the adapter watches `PROTON_MAIL_MAILBOX` (`INBOX`). Proton's spam filter or a custom filter may have moved the mail.
5. Backlog: mail that was already in the inbox when the adapter first connected is skipped by design — see `PROTON_MAIL_PROCESS_BACKLOG`.

### Replies not sending (`SMTP` errors in `logs/nanoclaw.error.log`)

- `Must issue a STARTTLS command first` — the SMTP port is right but TLS is off in Bridge; leave Bridge on its default STARTTLS setting.
- `self signed certificate` — `PROTON_MAIL_TLS_REJECT_UNAUTHORIZED` was set to `true`; Bridge's loopback cert is self-signed. Set it back to `false` (the default).
- Rate limits — Proton caps outbound mail per day by plan. The error names the limit.

### Bridge container keeps restarting

`docker logs nanoclaw-proton-bridge`. A vault that can't be unlocked (the `pass`
keyring in the volume is damaged) prints GPG errors; recover by removing the
volume and logging in again: `docker rm -f nanoclaw-proton-bridge; docker volume rm nanoclaw-proton-bridge`, then the **init** step.

### Bot not responding — service side

- Service running: `systemctl --user status "$(. setup/lib/install-slug.sh && systemd_unit)"` (Linux) / `launchctl print gui/$(id -u)/"$(. setup/lib/install-slug.sh && launchd_label)"` (macOS)
- `logs/nanoclaw.error.log` for `No adapter for channel type channelType="proton-mail"` — the factory returned `null`, which means `PROTON_MAIL_ADDRESS` or `PROTON_MAIL_BRIDGE_PASSWORD` is missing from `.env`.
