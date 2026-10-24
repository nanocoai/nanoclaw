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
and exposes ordinary IMAP/SMTP. Proton only ships Bridge binaries for x86; this
skill builds it from source inside Docker, which works on arm64 (Raspberry Pi
4/5) and x86 alike. Bridge runs as an unprivileged user on a Docker network of
its own (`nanoclaw-mail`), with its ports published on the host's `127.0.0.1`
only: the NanoClaw host process is the only thing that reaches it — not agent
containers, not the network.

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
user able to run it (NanoClaw's own agent containers already need this). The
setup script below also uses `openssl` to check Bridge's certificate:

```nc:run effect:check
docker info >/dev/null 2>&1 && command -v openssl >/dev/null
```

## Apply

### 1. Copy the adapter and its tests

Fetch the `channels` branch and copy the Proton Mail adapter, its registration
test, and its unit and behaviour tests (overwrite — the branch is canonical).
The Bridge container files (`bridge/`) ship in this skill's own directory and
are used in place:

```nc:copy from-branch:channels
src/channels/proton-mail.ts
src/channels/proton-mail-registration.test.ts
src/channels/proton-mail.test.ts
src/channels/proton-mail-adapter.test.ts
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
mailparser@3.9.47
nodemailer@10.1.7
@types/mailparser@3.4.6
@types/nodemailer@8.0.1
```

### 4. Build and validate

Build first: it typechecks the adapter against core and proves the dependencies
are installed. Then run the integration test and the adapter's tests.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/proton-mail-registration.test.ts src/channels/proton-mail.test.ts src/channels/proton-mail-adapter.test.ts
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
re-runs are cached and return immediately. The release is pinned in the
Dockerfile by `BRIDGE_VERSION` and its commit `BRIDGE_COMMIT`, and the base
images by digest:

```nc:run effect:external
docker build -t nanoclaw-proton-bridge:latest .claude/skills/add-proton-mail/bridge
```

Bridge stores the account login in a `pass` keyring inside the container. It
lives in a named Docker volume, `nanoclaw-proton-bridge`, so it survives
container and image replacement. Bridge runs as uid 10001, so the volume must
belong to that user — a no-op on a fresh install, a one-time fix for a volume an
older, root-run version of this skill created:

```nc:run effect:external
docker volume inspect nanoclaw-proton-bridge >/dev/null 2>&1 || docker volume create nanoclaw-proton-bridge >/dev/null; docker run --rm --user 0 --log-driver none -v nanoclaw-proton-bridge:/root --entrypoint chown nanoclaw-proton-bridge:latest -R 10001:10001 /root
```

The login itself is interactive (Proton asks for the account password, a 2FA
code if enabled, and the mailbox password on two-password accounts), so it has
to run in a real terminal. Tell the user:

```nc:operator
Sign the Bridge in to your Proton account. In a real terminal (SSH session or local shell — the login needs a TTY):

    docker run --rm -it -v nanoclaw-proton-bridge:/root nanoclaw-proton-bridge:latest init

At the `>>>` prompt:
  1. Type `login` and follow the prompts (Proton username, password, 2FA code if you use one, mailbox password on two-password accounts).
  2. Wait for "Account <you> was added successfully" — the first sync can take a minute.
  3. Type `updates autoupdates disable` and answer yes. Bridge's own updater would replace this source build with Proton's binary (which cannot run on arm64 at all).
  4. Type `exit`.

Nothing to copy: the bridge password is read from Bridge's vault in the next step.
```

Bridge authenticates IMAP/SMTP with a **bridge password** — a random string it
generates, not the Proton account password. A helper script reads it straight
from the vault and writes it to `.env` (mode 600) without printing it, so it is
never transcribed by hand and never lands in a setup log. The vault is read
inside the container and only single fields leave it: the decrypted vault also
holds the Proton session's refresh token and key passphrase. The same script
saves Bridge's TLS certificate to `store/proton-mail/bridge-cert.pem` and points
`PROTON_MAIL_TLS_CA_FILE` at it, so the adapter verifies the certificate rather
than trusting whatever answers on `127.0.0.1`. The Proton account password is
never stored anywhere in NanoClaw:

```nc:run effect:external
bash .claude/skills/add-proton-mail/bridge/store-secrets.sh
```
```nc:run effect:check
grep -Eq '^PROTON_MAIL_BRIDGE_PASSWORD=[A-Za-z0-9+/_-]{20,}$' .env && grep -q '^PROTON_MAIL_TLS_CA_FILE=' .env
```

The account's primary address is in the vault too. Read it, then confirm which
address the agent should send from — the primary, or any alias on the same
account (all aliases share one inbox and one bridge password):

```nc:run effect:fetch capture:primary_email validate:^[^@\s]+@[^@\s]+\.[^@\s]+$
docker run --rm --log-driver none -v nanoclaw-proton-bridge:/root nanoclaw-proton-bridge:latest secrets address
```

```nc:prompt proton_address normalize:lower validate:^[^@\s]+@[^@\s]+\.[^@\s]+$
Which address should the agent use? Bridge signed in as `{{primary_email}}` — press through with that, or give an alias on the same Proton account (e.g. `assistant@proton.me`) to send from instead.
```

Write it to `.env` (set-if-absent; edit `.env` directly to change it later):

```nc:env-set
PROTON_MAIL_ADDRESS={{proton_address}}
```

## Run Bridge

Start Bridge as a long-lived container. Its IMAP (1143) and SMTP (1025) ports are
published on `127.0.0.1` only — anyone who can reach them with the bridge
password can read the whole mailbox, so they must never be exposed on `0.0.0.0`.
It runs on a Docker network of its own (`nanoclaw-mail`), not the default
`bridge` network agent containers use when egress lockdown is off, so no agent
container can reach its ports directly; the host reaches it through the loopback
ports. It runs with no Linux capabilities. `--restart unless-stopped` brings it
back across reboots. Re-running replaces the container in place (the login lives
in the volume, not the container):

```nc:run effect:external
docker network inspect nanoclaw-mail >/dev/null 2>&1 || docker network create nanoclaw-mail >/dev/null; docker rm -f nanoclaw-proton-bridge >/dev/null 2>&1; docker run -d --name nanoclaw-proton-bridge --restart unless-stopped --network nanoclaw-mail --cap-drop ALL --security-opt no-new-privileges -p 127.0.0.1:1025:2025 -p 127.0.0.1:1143:2143 -v nanoclaw-proton-bridge:/root nanoclaw-proton-bridge:latest
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

Mail counts as from {{owner_email}} only when Proton verified the sender (DMARC pass for that domain); anything else is left unread in the inbox. Mail from anyone else is held for your approval the first time they write (unknown_sender_policy: request_approval) — nothing reaches the agent until you approve the sender. Bounces, auto-replies, mailing lists and the agent's own mail are filtered out automatically.

Approval requests arrive as emails whose subject starts with a reference like [NC-…]. Answer by replying to that email itself, keeping its subject, with the command (e.g. /approve) on the first line.
```

## Security

What the adapter trusts, and why:

- **Who a mail is from.** The `From:` header is the sender's own claim. Proton's
  inbound servers check SPF, DKIM and DMARC alignment of the `From:` domain when
  mail arrives and record the result in `Authentication-Results` headers under
  their own authserv-id, `mail.protonmail.ch`; Bridge adds no verdict of its
  own and serves those headers as Proton stored them. The adapter counts a mail
  as from its address only when there is exactly one Proton DMARC verdict, it
  is `pass`, and it names the `From:` domain. A forger can add their own
  `mail.protonmail.ch` header but cannot remove Proton's, so a forgery shows two
  verdicts and is refused. A domain's DMARC policy doesn't matter: with `p=none`
  Proton still delivers forged mail, but records `dmarc=fail`. A `From:` with
  more than one address is refused. Refused mail is logged and left unread.
- **What DMARC does not prove.** DMARC vouches for a domain, not a mailbox: the
  adapter relies on the sender's own domain to stop its users sending as each
  other (and any shared service in the domain's SPF record widens who can send
  for it). For the owner, use an address on a domain with tight sending
  controls. Mail between two Proton accounts may carry no DMARC verdict and is
  then refused.
- **Approvals.** Because of that, an approval needs more than a verified
  sender. Each card mail carries a random token in its subject; an answer counts
  only from the card's approver, quoting the token, sent `In-Reply-To` the card
  mail itself, with one of the card's commands on the first line — so only
  someone who can read the approver's mailbox can answer, and a reply always
  answers the card it replies to. Cards are kept in `store/proton-mail/state.json`
  and survive a restart.
- **Admin commands.** A `/` command on the first line of a verified owner's mail
  reaches core's command gate like any other channel's.
- **Transport.** IMAP requires STARTTLS (never opportunistic) and SMTP requires
  TLS. With `PROTON_MAIL_TLS_CA_FILE` set (the default from setup) Bridge's own
  certificate is verified on every connection, so a process squatting the
  loopback port while Bridge is down cannot collect the bridge password.
- **What anyone with the volume holds.** The `nanoclaw-proton-bridge` volume is
  the Proton login. Its keyring key is unprotected (headless), so anyone with
  root or Docker on this host can read the mailbox — as with any credential on
  the host.

## Channel Info

- **type**: `proton-mail`
- **terminology**: Email has correspondents, not chats or groups. Each sender address is its own conversation.
- **platform-id-format**: the correspondent's address, lowercased, as-is — `someone@example.com`. Native adapter — no `proton-mail:` prefix. User ids are `proton-mail:someone@example.com`.
- **how-to-find-id**: It's the sender's email address. Auto-discovered on first mail — check `pnpm exec tsx scripts/q.ts data/v2.db "SELECT platform_id, name FROM messaging_groups WHERE channel_type='proton-mail'"`.
- **supports-threads**: no — one session per correspondent. Replies are threaded in the correspondent's mail client via `In-Reply-To`/`References`.
- **typical-use**: Email in, email out. Forward a document for summary; email the agent a question; let it send scheduled reports.
- **default-isolation**: One agent group per Proton address is the natural unit. Multiple correspondents share the agent but get separate sessions.

### Features

- Inbound: body (quoted reply history stripped) then a `Subject:` line, attachments saved to the session inbox (up to 15 MB each), HTML-only mail flattened to text; a `/command` on the first line is a command
- Outbound: plain-text replies, `Re:` subject, threaded onto the correspondent's last mail; file attachments from the session outbox
- Approval questions — cards go out as their own mail with a `[NC-…]` reference in the subject and `/approve`-style commands; answer by replying to that mail with the command on the first line
- Display cards (`send_card`) — sent as their plain-text version, with the card's links
- Edits — email cannot change a sent mail, so an edit goes out as a follow-up on the edited mail's thread: an agent's edit as "Correction to my earlier message", the resolution of an approval card as an update to that card
- Loop safety — the agent's own mail carries an `X-NanoClaw-Agent` header and is never re-ingested; `Auto-Submitted`, `Precedence: bulk/junk/list`, `List-Id`, `X-Autoreply`, null `Return-Path` bounces, delivery reports and `mailer-daemon`/`noreply` senders are dropped
- Live delivery via IMAP IDLE, with a 60 s fallback poll; a mail whose handling fails is retried with back-off up to five times, then left unread and flagged `$NanoClawFailed`

Not supported: reactions, typing indicators, deleting sent mail, groups/mailing-list semantics (a CC'd thread is still one conversation per sender).

## Optional configuration

All `.env` keys the adapter reads. Only the first two are required; setup also
writes `PROTON_MAIL_TLS_CA_FILE`.

```bash
PROTON_MAIL_ADDRESS=assistant@proton.me     # Bridge account
PROTON_MAIL_BRIDGE_PASSWORD=...             # written by bridge/store-secrets.sh
PROTON_MAIL_FROM_NAME=Nano                  # display name on outbound mail
PROTON_MAIL_IMAP_HOST=127.0.0.1             # Bridge IMAP (default 127.0.0.1:1143)
PROTON_MAIL_IMAP_PORT=1143
PROTON_MAIL_SMTP_HOST=127.0.0.1             # Bridge SMTP (default 127.0.0.1:1025)
PROTON_MAIL_SMTP_PORT=1025
PROTON_MAIL_TLS_CA_FILE=store/proton-mail/bridge-cert.pem   # pin Bridge's certificate (verified on every connection)
PROTON_MAIL_TLS_REJECT_UNAUTHORIZED=        # unset: verify except on loopback; true/false forces it (ignored when the CA file is set)
PROTON_MAIL_MAILBOX=INBOX                   # folder to watch
PROTON_MAIL_POLL_SECONDS=60                 # fallback poll behind IDLE; also when failed mail is retried
PROTON_MAIL_MARK_SEEN=true                  # mark handled mail read in Proton
PROTON_MAIL_PROCESS_BACKLOG=false           # true: ingest all existing mail on first start
PROTON_MAIL_DEFAULT_SUBJECT=Message from your assistant   # for agent-initiated mail with no thread
```

On first connect the adapter records the mailbox's current position and only
processes mail that arrives afterwards; set `PROTON_MAIL_PROCESS_BACKLOG=true`
(and delete `store/proton-mail/state.json`) to ingest what's already there,
read or unread.

### Upgrading Bridge

Bridge's own updater is no use here: it downloads Proton's x86 binary, which
cannot run on an arm64 host, and which would replace the pinned source build
on x86. The image runs Bridge without its launcher and discards any download,
and auto-update is switched off at login (step 3 of the sign-in).

To upgrade, set `BRIDGE_VERSION` in `.claude/skills/add-proton-mail/bridge/Dockerfile`
to a newer [upstream release](https://github.com/ProtonMail/proton-bridge/releases)
(its notes are in the repo's `Changelog.md` at that tag) and `BRIDGE_COMMIT` to
the commit that tag points at — the build fails if they disagree:

    git ls-remote https://github.com/ProtonMail/proton-bridge.git refs/tags/vX.Y.Z

Then re-run the **Build** and **Run Bridge** steps. The login in the volume
carries over. The running release is on the image label:

    docker inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' nanoclaw-proton-bridge

## Troubleshooting

### `login` fails or asks for something unexpected

- **"Invalid credentials" on a correct password** — the account is on Proton Free, or the password has a leading/trailing space. Bridge needs a paid plan.
- **Two-password mode** — Bridge asks for the mailbox password after the account password. Both are needed.
- **2FA** — enter the TOTP code from your authenticator when prompted. Passkey/FIDO2 sign-in works if the hardware key is passed to the container; TOTP is simpler.
- **Captcha / "human verification"** — Proton sometimes demands a browser captcha for a new device. Sign in once at mail.proton.me from the same network, then retry `login`.
- **`permission denied` on the vault or keyring** — the volume still belongs to root from an older version of this skill. Re-run the `chown` step under **Build Proton Mail Bridge**.

### Adapter logs `IMAP connect failed` / `ECONNREFUSED`

Bridge isn't listening. `docker ps --filter name=nanoclaw-proton-bridge` should
show it running; `docker logs nanoclaw-proton-bridge` shows why not. Common
cause: the container was started before `init` completed, so the vault is empty
— finish `login`, then re-run the **Run Bridge** step.

### Adapter logs `IMAP connect failed … Command failed`; Bridge log says `no such user`

`PROTON_MAIL_BRIDGE_PASSWORD` doesn't match. Bridge's `no such user` is its
answer to *any* credential mismatch, not just an unknown address. Re-read it
from the vault rather than retyping: delete the `PROTON_MAIL_BRIDGE_PASSWORD=`
line from `.env`, then run

```bash
bash .claude/skills/add-proton-mail/bridge/store-secrets.sh
```

and restart. Bridge regenerates the password if you `delete` and re-add the
account, so repeat this after any re-login. Bridge also rate-limits after a few
failures (`too many login attempts`); the adapter's backoff rides that out on
its own.

### Adapter logs a certificate error, or `PROTON_MAIL_TLS_CA_FILE cannot be read`

The pinned certificate no longer matches Bridge's (a new vault after deleting
the volume creates a new one), or the file is gone. The adapter refuses to
start rather than fall back to unverified TLS. Re-run `store-secrets.sh` (it
always re-exports the certificate) and restart.

### Mail arrives in Proton but the agent never wakes

1. Adapter connected: `grep "Proton Mail adapter connected" logs/nanoclaw.log | tail -1`
2. Sender verified: `grep "sender is unverified\|single sender" logs/nanoclaw.log | tail` — mail without a Proton DMARC pass for its `From:` domain is left unread on purpose (see **Security**).
3. Sender wired or approved: `pnpm exec tsx scripts/q.ts data/v2.db "SELECT platform_id, unknown_sender_policy, denied_at FROM messaging_groups WHERE channel_type='proton-mail'"` — a first-time sender is held for approval; check `ncl approvals list`.
4. Not filtered: the adapter drops `Auto-Submitted`, `Precedence: bulk/junk/list`, `List-Id`, null-`Return-Path` bounces and `noreply@`/`mailer-daemon@` senders (`logs/nanoclaw.log` at debug: `Proton Mail inbound skipped`).
5. Handling failed: `grep "will retry\|giving up on a mail" logs/nanoclaw.log | tail` — a mail flagged `$NanoClawFailed` was tried five times and left unread.
6. Right folder: the adapter watches `PROTON_MAIL_MAILBOX` (`INBOX`). Proton's spam filter or a custom filter may have moved the mail.
7. Backlog: mail that was already in the inbox when the adapter first connected is skipped by design — see `PROTON_MAIL_PROCESS_BACKLOG`.

### An approval reply did nothing

`grep "not taken as a card answer" logs/nanoclaw.log | tail` names the reason,
and the sender gets a short mail saying why. The reply must be to the request
email itself (not a new mail), keep its `[NC-…]` subject, and start with one of
the listed commands. A request that was already answered, or expired, cannot be
answered again.

### Replies not sending (`SMTP` errors in `logs/nanoclaw.error.log`)

- `Must issue a STARTTLS command first` — the SMTP port is right but TLS is off in Bridge; leave Bridge on its default STARTTLS setting.
- `self signed certificate` — `PROTON_MAIL_TLS_CA_FILE` is unset and `PROTON_MAIL_TLS_REJECT_UNAUTHORIZED=true` was forced. Run `store-secrets.sh` to pin Bridge's certificate instead.
- Rate limits — Proton caps outbound mail per day by plan. The error names the limit.

### Bridge container keeps restarting

`docker logs nanoclaw-proton-bridge`. A vault that can't be unlocked (the `pass`
keyring in the volume is damaged) prints GPG errors; recover by removing the
volume and logging in again: `docker rm -f nanoclaw-proton-bridge; docker volume rm nanoclaw-proton-bridge`, then the `chown` and **init** steps, `store-secrets.sh` (delete the old `PROTON_MAIL_BRIDGE_PASSWORD` line first), and **Run Bridge**.

### Bot not responding — service side

- Service running: `systemctl --user status "$(. setup/lib/install-slug.sh && systemd_unit)"` (Linux) / `launchctl print gui/$(id -u)/"$(. setup/lib/install-slug.sh && launchd_label)"` (macOS)
- `logs/nanoclaw.error.log` for `No adapter for channel type channelType="proton-mail"` — the factory returned `null`, which means `PROTON_MAIL_ADDRESS` or `PROTON_MAIL_BRIDGE_PASSWORD` is missing from `.env`, or `PROTON_MAIL_TLS_CA_FILE` names a file that cannot be read.
