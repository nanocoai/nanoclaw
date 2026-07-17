---
name: add-imessage
description: Add iMessage to NanoClaw — one channel, two backends. Local (this Mac's chat.db via the Chat SDK bridge; macOS + Full Disk Access) or Hosted iMessage (via photon.codes — native spectrum-ts with a device-login wizard; any OS, no Mac relay). Triggers on "add imessage", "connect imessage", "add photon", "imessage via photon", "native imessage".
---

# Add iMessage

NanoClaw talks to iMessage through a single **`imessage`** channel with two
pluggable backends. This skill installs one of them:

- **Local (this Mac)** — the Chat SDK bridge over `chat-adapter-imessage`,
  reading this Mac's signed-in iMessage account (`chat.db`). macOS only; the
  Node binary needs Full Disk Access.
- **Hosted iMessage (via photon.codes)** — a native adapter over Photon's
  `spectrum-ts` gRPC stream. The hosted service owns the iMessage line, so
  there's no Mac relay, webhook, or public URL. Works on any OS, and a
  device-login wizard provisions everything for you.

Both register the same `imessage` channel type; only one runs per install. Full
reference: [docs/imessage.md](../../docs/imessage.md).

## Choose a backend

Ask the user which backend to install (use **AskUserQuestion**):

- **Local (this Mac)** — macOS only; uses this machine's iMessage account.
- **Hosted iMessage (via photon.codes)** — any OS; managed line, no Mac needed.

On non-macOS, only **Hosted** is possible — the local backend reads this Mac's
`chat.db`. Follow the matching section below.

## Install (both backends)

NanoClaw doesn't ship channel adapters in trunk. This skill copies the unified
`imessage` adapter in from the `channels` branch — but **only if
`src/channels/imessage.ts` is not already present**. Never overwrite an
existing copy: a previously installed or locally updated adapter may be newer
than the channels-branch version. (On a fork, the `channels` branch lives on
your `upstream` remote — substitute that remote name for `origin` below.)

### Pre-flight (idempotent)

Each step guards itself — skip the ones whose condition already holds:

- `src/channels/imessage.ts`, `src/channels/imessage.test.ts`, and
  `src/channels/imessage-registration.test.ts` all exist → skip steps 1–2
  (no fetch, no copy)
- `src/channels/index.ts` contains `import './imessage.js';` → skip step 3
- the chosen backend's package is in `package.json` deps
  (`chat-adapter-imessage` for Local, `spectrum-ts` for Hosted) → skip step 4
- if every step above was skipped, skip step 5 too and go straight to the
  backend section

Every step is safe to re-run.

### 1. Fetch the channels branch (only if adapter files are missing)

```bash
git fetch origin channels
```

### 2. Copy the adapter and its tests (only the missing files)

```bash
[ -f src/channels/imessage.ts ] || \
  git show origin/channels:src/channels/imessage.ts > src/channels/imessage.ts
[ -f src/channels/imessage.test.ts ] || \
  git show origin/channels:src/channels/imessage.test.ts > src/channels/imessage.test.ts
[ -f src/channels/imessage-registration.test.ts ] || \
  git show origin/channels:src/channels/imessage-registration.test.ts > src/channels/imessage-registration.test.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if already present):

```typescript
import './imessage.js';
```

### 4. Install the chosen backend's package (pinned)

**Local:**

```bash
pnpm install chat-adapter-imessage@0.1.1
```

**Hosted:**

```bash
pnpm install spectrum-ts@11.0.0
```

> Pin exactly. `spectrum-ts` ships breaking majors (v11 is what the adapter
> targets); don't `@latest`. NanoClaw's pnpm gate (`minimumReleaseAge`) requires
> a version ≥3 days old — both pins clear it. A fresher pin needs human sign-off
> before a `minimumReleaseAgeExclude` entry (CLAUDE.md → Supply Chain Security).

### 5. Build and validate

```bash
pnpm run build
pnpm exec vitest run src/channels/imessage-registration.test.ts
```

Both must be clean. `imessage-registration.test.ts` imports the real channel
barrel and asserts the registry contains `imessage` — it goes red if the
`import './imessage.js';` line is missing or the barrel fails to evaluate. The
adapter loads neither backend's SDK at import (hosted `spectrum-ts` only in
`setup()`, local `chat-adapter-imessage` only in the factory), so the test needs
no package. For the Local backend, `pnpm run build` guards the Chat SDK bridge's
typed core API.

Now follow the section for your chosen backend.

## Local backend (macOS)

### Full Disk Access

The adapter reads this Mac's `chat.db`, which requires Full Disk Access granted
to the Node binary. The Node path is buried (e.g. `~/.nvm/.../bin/node`), so open
its folder in Finder:

```bash
open "$(dirname "$(which node)")"
```

Then tell the user:

1. Open **System Settings → Privacy & Security → Full Disk Access**
2. Click **+**, drag the `node` file from the Finder window that just opened
3. Toggle it on

Stop and wait for the user to confirm before continuing.

### Configure environment

Add to `.env`:

```bash
IMESSAGE_BACKEND=local
IMESSAGE_ENABLED=true
```

### Restart

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
```

### Wire the channel

Message the Mac's iMessage account, then wire the DM to an agent:

```bash
npx tsx scripts/init-first-agent.ts \
  --channel imessage \
  --user-id imessage:<your-phone-or-email> \
  --platform-id <your-phone-or-email> \
  --display-name "You"
```

Or run `/init-first-agent` / `/manage-channels` interactively.

## Hosted iMessage backend (via photon.codes)

### Setup wizard

The wizard runs Photon's device-login flow, finds/creates your project, mints
the project secret, registers your phone, and surfaces the iMessage number
you'll text — writing `PHOTON_PROJECT_ID` + `PHOTON_PROJECT_SECRET` to `.env`.

```bash
pnpm exec tsx scripts/photon-setup.ts --phone +15551234567
```

Replace with your own iMessage number in E.164 format. Omit `--phone` to be
prompted (interactive terminals only). The wizard prints a URL and a code:

1. Open the printed URL (`https://app.photon.codes/...`) in a browser
2. Approve the device and enter the code shown
3. The wizard finishes automatically once you approve

When it completes it prints **your agent's iMessage number** — the number to
text to reach the agent (also saved to `data/photon-auth.json`).

Flags: `--project-name <name>` (default `NanoClaw`), `--no-browser`,
`--non-interactive`, `--dashboard-host` / `--spectrum-host`. Check state with
`pnpm exec tsx scripts/photon-setup.ts status`.

Optionally set `IMESSAGE_BACKEND=hosted` in `.env` — the Photon credentials
already imply hosted, but an explicit selector avoids ambiguity if local creds
linger.

### Restart

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
systemctl --user restart $(systemd_unit)               # Linux
```

Confirm it connected:

```bash
grep "Photon channel connected" logs/nanoclaw.log | tail -1
```

### Wire the channel

Text your agent's iMessage number once. The router auto-creates a
`messaging_groups` row; the wizard prints a ready-to-run command:

```bash
npx tsx scripts/init-first-agent.ts \
  --channel imessage \
  --user-id imessage:+15551234567 \
  --platform-id +15551234567 \
  --display-name "You"
```

Or run `/init-first-agent` / `/manage-channels` interactively.

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
`PHOTON_SPECTRUM_HOST`. Full table in [docs/imessage.md](../../docs/imessage.md).

## Troubleshooting

- **`spectrum-ts` not installed** (hosted) — run step 4 (`pnpm install spectrum-ts@11.0.0`) and restart.
- **Bot silent** — confirm the backend connected (hosted: `grep "Photon channel connected" logs/nanoclaw.log`), the channel is wired, and the service is running.
- **Device login times out** (hosted) — the code expires in ~30 min; re-run the wizard (a stored token is reused).
- **Local: no inbound** — confirm Full Disk Access is granted to the Node binary, and NanoClaw runs on the signed-in Mac.

More in [docs/imessage.md](../../docs/imessage.md).

## Upgrading spectrum-ts (hosted)

`spectrum-ts` is pinned exactly because it ships breaking majors. To upgrade,
read the [release notes](https://github.com/photon-hq/spectrum-ts/releases) for
every version between the pins, bump the pin, reconcile
`src/channels/imessage.ts` against the new typings, then `pnpm run build` and
`pnpm exec vitest run src/channels/imessage.test.ts`. See
[docs/imessage.md](../../docs/imessage.md).
