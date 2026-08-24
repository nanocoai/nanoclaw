---
name: add-imessage
description: Add iMessage to NanoClaw — one channel, two backends. Local (this Mac's chat.db via the Chat SDK bridge; macOS + Full Disk Access) or Hosted iMessage (via photon.codes — native spectrum-ts with a device-login wizard; any OS, no Mac relay). Triggers on "add imessage", "connect imessage", "add photon", "imessage via photon", "native imessage".
---

# Add iMessage

NanoClaw talks to iMessage through a single **`imessage`** channel with two
pluggable backends:

- **Local (this Mac)** — the Chat SDK bridge over `chat-adapter-imessage`,
  reading this Mac's signed-in iMessage account (`chat.db`). macOS only; the
  Node binary needs Full Disk Access.
- **Hosted iMessage (via photon.codes)** — a native adapter over Photon's
  `spectrum-ts` gRPC stream. The hosted service owns the iMessage line, so
  there's no Mac relay, webhook, or public URL. Works on any OS, and a
  device-login flow provisions everything for you.

Both register the same `imessage` channel type; only one runs per install.
NanoClaw doesn't ship channels in trunk — this skill copies the unified
`imessage` adapter in from the `channels` branch. Full reference:
[docs/imessage.md](docs.md).

The mechanical steps under **Apply** carry `nc:` directive fences: an agent reads
the prose and applies them, and a parser can apply them deterministically from
the same document. Every directive is idempotent, so the whole skill is safe to
re-run; anything a parser can't apply falls back to the prose beside it.

## Apply

### 1. Choose a backend

Pick the backend first — it decides which package gets installed and which
walkthrough runs below (the other backend's steps are skipped):

```nc:prompt backend validate:^(local|hosted)$
How should iMessage run — `local` (this Mac's signed-in iMessage account; macOS only, needs Full Disk Access) or `hosted` (a managed line via photon.codes; works on any OS)?
```

The local backend only works on a Mac — it reads this machine's iMessage
`chat.db` directly, and there is no such database off macOS. On any other OS,
stop here and choose `hosted` instead; otherwise you'd write a local config
that can never receive a message:

```nc:run effect:check when:backend=local
[ "$(uname)" = Darwin ]
```

### 2. Copy the adapter

Fetch the `channels` branch and copy the unified iMessage adapter and its tests
into `src/channels/`:

```nc:copy from-branch:channels
src/channels/imessage.ts
src/channels/imessage.test.ts
src/channels/imessage-registration.test.ts
```

### 3. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './imessage.js';
```

### 4. Install the chosen backend's package

Pinned to an exact version — the supply-chain policy rejects ranges and
`latest`. Install only the chosen backend's package.

**Local** — the Chat SDK iMessage adapter:

```nc:dep when:backend=local
chat-adapter-imessage@0.1.1
```

**Hosted** — Photon's Spectrum SDK:

```nc:dep when:backend=hosted
spectrum-ts@11.0.0
```

> Pin exactly. `spectrum-ts` ships breaking majors (v11 is what the adapter
> targets); don't `@latest`. NanoClaw's pnpm gate (`minimumReleaseAge`) requires
> a version ≥3 days old — both pins clear it. A fresher pin needs human sign-off
> before a `minimumReleaseAgeExclude` entry (CLAUDE.md → Supply Chain Security).

### 5. Build and validate

Build guards the typed `createChatSdkBridge(...)` core call used by the local
backend, and the registration test proves the channel is wired:

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/imessage-registration.test.ts
```

Both must be clean. `imessage-registration.test.ts` imports the real channel
barrel and asserts the registry contains `imessage` — it goes red if the
`import './imessage.js';` line is missing or the barrel fails to evaluate. The
adapter loads neither backend's SDK at import (hosted `spectrum-ts` only in
`setup()`, local `chat-adapter-imessage` only in the factory), so the test
needs no package.

For the hosted backend, also run the full adapter suite — it includes an
integration block that exercises the real installed `spectrum-ts` (version,
exports, builders) and auto-skips when the package is absent:

```nc:run effect:test when:backend=hosted
pnpm exec vitest run src/channels/imessage.test.ts
```

## Local backend: Full Disk Access (macOS)

The adapter reads this Mac's `chat.db`, which requires Full Disk Access granted
to the Node binary the host runs under. The Node path is buried deep (e.g.
`~/.nvm/versions/node/v22.x.x/bin/node`), so open its folder in Finder to make
the drag-and-drop target obvious. Harmless off a desktop (SSH/headless) — it
just no-ops:

```nc:run effect:external when:backend=local
open "$(dirname "$(which node)")" 2>/dev/null || true
```

Then tell the user:

```nc:operator when:backend=local
Grant Full Disk Access to Node so iMessage can read your chat history:
1. Open System Settings > Privacy & Security > Full Disk Access.
2. Click +, then drag the "node" file from the Finder window that just opened.
3. Toggle it on, then come back here.
```

Stop and wait for the user to confirm Full Disk Access is granted before
continuing.

Now select the local backend in `.env`. The configure script owns this
upsert-and-remove (a plain set-if-absent env write can neither replace a stale
value nor delete a key, and a lingering hosted selector would shadow the
choice):

```nc:run effect:external when:backend=local
bash setup/channels/imessage-configure.sh local
```

## Hosted backend: device login (via photon.codes)

The provisioning flow needs the phone number you send iMessages from — it
registers that number with your project so the hosted line recognises you:

```nc:prompt owner_handle normalize:trim validate:^\+\d{8,15}$ when:backend=hosted
The phone number you iMessage from, in E.164 format — + followed by country code and number, no spaces or dashes (e.g. +14155551234).
```

Tell the user what's about to happen:

```nc:operator when:backend=hosted
Connect your hosted iMessage line (photon.codes):
1. A login URL and a short code will print below.
2. Open the URL in a browser, approve the device, and enter the code.
3. Setup then registers your number and prints the iMessage line Photon assigned to it. Send one message from your phone to that line — a number only enters routing after it has texted its line once.
4. Once the opt-in lands, setup finishes on its own and confirms your agent's iMessage number.
```

Run the device-login flow. It provisions the project, reuses its current secret
(regenerating only when the API returns none), registers your number, prints
the line to text and waits until that message opts the number in, and surfaces
the iMessage number you'll use — writing
`PHOTON_PROJECT_ID` + `PHOTON_PROJECT_SECRET` to `.env` and the assigned number
to `data/photon-auth.json`:

```nc:run effect:step when:backend=hosted
pnpm exec tsx scripts/photon-setup.ts setup --phone {{owner_handle}} --embedded
```

If the login times out, the code expired (~30 min) — re-run the step; a stored
token is reused. Check state any time with
`pnpm exec tsx scripts/photon-setup.ts status`.

Then select the hosted backend in `.env` — the Photon credentials already imply
hosted, but the explicit selector avoids ambiguity if local keys linger:

```nc:run effect:external when:backend=hosted
bash setup/channels/imessage-configure.sh hosted
```

## Restart

Restart the service so it loads the iMessage adapter and the backend config you
just wrote, and wait for its CLI socket before wiring:

```nc:run effect:restart
bash setup/lib/restart.sh
```

For the hosted backend, confirm the connection came up:
`grep "Photon channel connected" logs/nanoclaw.log | tail -1`.

## Resolve your iMessage handle

The agent greets you in the iMessage conversation tied to the handle you
message from — that handle is both your identity and the conversation address.
The hosted flow already collected it above; for the local backend, resolve it
now (email works too — whatever iMessage recognises):

```nc:prompt owner_handle validate:^(\+\d{8,15}|[^\s@]+@[^\s@]+\.[^\s@]+)$ when:backend=local
The phone number or email you iMessage from — a +E.164 number (e.g. +14155551234) or an email / Apple ID (e.g. you@icloud.com).
```

**Hosted first contact:** text your agent's iMessage number once (it was
printed above; also stored in `data/photon-auth.json`) before expecting any
message from it. This first text is required, not just convenient — the hosted
line can only message numbers that have already texted it (cold outbound is
rejected with `Target not allowed for this project`). Tell the user:

```nc:operator when:backend=hosted
Send one text — anything — from your phone to your agent's iMessage number (printed above). The hosted line can only reply to numbers that have texted it first, so its welcome message needs yours to arrive first.
```

iMessage is a native channel: it sends the raw handle as the conversation
address, with no channel prefix — so the messaging-group platform id is that
handle as-is:

```nc:run capture:platform_id
echo "{{owner_handle}}"
```

`owner_handle` and `platform_id` are what the owner-wiring step needs. The
welcome iMessage goes out through the adapter once the service is running — on
the local backend that needs Full Disk Access granted (above); on the hosted
backend it goes out via your photon.codes line after your first text.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise
`/init-first-agent` stands up an agent on your iMessage DM, or `/manage-channels`
wires it to an existing agent group.

## Channel Info

- **type**: `imessage` (one channel; the backend is local or hosted)
- **terminology**: iMessage has 1:1 "chats" (DMs) and group chats. Photon
  (hosted) calls each conversation a "space".
- **platform-id-format**: DM = your bare handle (E.164 phone, or email for
  local) — direct-addressable; the user id is `imessage:<handle>`. Group
  (hosted) = the opaque Spectrum space id.
- **how-to-find-id**: DMs use the counterpart's phone/email. Groups (hosted) are
  discovered on first message —
  `pnpm exec tsx scripts/q.ts data/v2.db "SELECT platform_id, name FROM messaging_groups WHERE channel_type='imessage'"`
- **supports-threads**: no
- **typical-use**: Interactive 1:1 chat — personal messaging
- **default-isolation**: One agent per install. Multiple DMs with the same
  operator can share an agent group; groups with other people should typically
  use `isolated` session mode.

### Hosted features

Markdown (native; `PHOTON_MARKDOWN=false` for plain text), file attachments in
and out (inbound staged into the session inbox, capped by
`PHOTON_MAX_INLINE_ATTACHMENT_BYTES`, default 20 MB), tapback reactions, read
receipts, typing indicators, and `ask_user_question` via `/approve` / `/reject`
slash replies. Optional `.env`: `PHOTON_MARKDOWN`, `PHOTON_TELEMETRY`,
`PHOTON_MAX_INLINE_ATTACHMENT_BYTES`, `PHOTON_DASHBOARD_HOST`,
`PHOTON_SPECTRUM_HOST`. Full table in [docs/imessage.md](docs.md).

## Troubleshooting

**The backend answer is rejected.** It must be exactly `local` or `hosted`,
lowercase. Local only exists on macOS — it reads this Mac's `chat.db` directly —
so on any other OS the platform check stops you and hosted is the only path.

**Local: outgoing works but nothing ever arrives.** Full Disk Access wasn't
granted to the *actual* Node binary the service runs under — with nvm the path
changes per Node version (`~/.nvm/versions/node/v22.x.x/bin/node`), so an old
grant silently stops covering a new binary. Re-open System Settings → Privacy &
Security → Full Disk Access, add the binary at `$(which node)`, then restart
the service.

**`spectrum-ts` not installed** (hosted) — re-run step 4
(`pnpm install spectrum-ts@11.0.0`) and restart.

**Device login times out** (hosted) — the code expires in ~30 min; re-run the
login step (a stored token is reused).

**`Target not allowed for this project`** (hosted) — intended: the line only
messages numbers that have texted it first. Text the agent's number once, then
retry (a welcome DM queued before that first text simply fails delivery).

**Your handle is rejected at the resolve step.** It must be a bare +E.164
number (`+14155551234` — no spaces, dashes, or parentheses) or, on the local
backend, an email/Apple ID. Use the exact handle you actually send iMessages
from — a number-vs-email mismatch means your messages never map to the wired
conversation.

**Adapter installed but silent.** Run
`pnpm exec vitest run src/channels/imessage-registration.test.ts` — red means
the barrel import or the package install drifted, so re-run the Apply steps.
If green, confirm the backend connected (hosted:
`grep "Photon channel connected" logs/nanoclaw.log`), restart the service
(`bash setup/lib/restart.sh`), then check `logs/nanoclaw.error.log`.

More in [docs/imessage.md](docs.md).

## Upgrading spectrum-ts (hosted)

`spectrum-ts` is pinned exactly because it ships breaking majors. To upgrade,
read the [release notes](https://github.com/photon-hq/spectrum-ts/releases) for
every version between the pins, bump the pin, reconcile
`src/channels/imessage.ts` against the new typings, then `pnpm run build` and
`pnpm exec vitest run src/channels/imessage.test.ts`. See
[docs/imessage.md](docs.md).
