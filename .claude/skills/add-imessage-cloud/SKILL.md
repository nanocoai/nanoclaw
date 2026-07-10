---
name: add-imessage-cloud
description: Add native iMessage support via Photon (photon.codes) — the `imessage-cloud` channel. Copies the adapter in from the `channels` branch, then runs a device-login wizard that auto-provisions your Photon project, secret, phone, and iMessage line. No Mac relay, no webhook, no dashboard clicking. Triggers on "add imessage-cloud", "add photon", "imessage via photon", "native imessage".
---

# Add iMessage (native, via Photon) — the `imessage-cloud` channel

Connect NanoClaw to **iMessage** through [Photon](https://photon.codes) — a managed service that owns the iMessage line, so you don't run a Mac relay. Photon's free shared-line pool means anyone can get started without a paid plan.

This installs a **native adapter** (`src/channels/imessage-cloud.ts`) that speaks Photon's `spectrum-ts` gRPC stream directly on the host — both directions, no webhook, no public URL, no signing secret — plus a **setup wizard** that does all the Photon account provisioning for you.

Distinct from the `/add-imessage` skill, which drives Photon through the Chat SDK bridge in "remote mode": that channel is `imessage`; this one is `imessage-cloud`, and the two coexist (different registry keys, different credentials).

## How it works

- **Persistent connection.** `spectrum-ts` holds a long-lived gRPC stream to Photon. Inbound iMessages arrive on the SDK's `app.messages` stream; replies go out over the same connection. Like Discord/Slack, there's nothing to expose to the internet.
- **Host-side only.** Credentials (`PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`) live in `.env` and are read on the host — they never enter an agent container.
- **Dynamic import.** The adapter loads `spectrum-ts` via a runtime dynamic import, so the channel barrel evaluates (and the module registers) even before the SDK is installed; the factory returns an adapter only once credentials exist.

## Install

NanoClaw doesn't ship channel adapters in trunk. This skill copies the `imessage-cloud` adapter in from the `channels` branch. The provisioning wizard (`scripts/photon-setup.ts`) ships in trunk, so it does not need fetching.

### Pre-flight (idempotent)

Skip to **Setup wizard** if all of these are already in place:

- `src/channels/imessage-cloud.ts` exists
- `src/channels/index.ts` contains `import './imessage-cloud.js';`
- `spectrum-ts` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter + its registration test

```bash
git show origin/channels:src/channels/imessage-cloud.ts > src/channels/imessage-cloud.ts
git show origin/channels:src/channels/imessage-cloud-registration.test.ts > src/channels/imessage-cloud-registration.test.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './imessage-cloud.js';
```

### 4. Install the runtime SDK (pinned)

The adapter loads `spectrum-ts` at runtime; install it once:

```bash
pnpm install spectrum-ts@8.0.0
```

Pinned to an exact version — `spectrum-ts` ships breaking majors (v8 is what `src/channels/imessage-cloud.ts` is written against). Don't `@latest`; bump deliberately.

> Supply-chain note: NanoClaw's pnpm gate (`minimumReleaseAge`) requires a version to be ≥3 days old. `8.0.0` clears it. If a newer pin is needed and it's too fresh, either wait or get human sign-off before adding a `minimumReleaseAgeExclude` entry (see CLAUDE.md → Supply Chain Security).

### 5. Build and validate

```bash
pnpm run build
pnpm exec vitest run src/channels/imessage-cloud-registration.test.ts
```

Both must be clean before proceeding. `imessage-cloud-registration.test.ts` imports the real channel barrel and asserts the registry contains `imessage-cloud` — it goes red if the `import './imessage-cloud.js';` line is missing or the barrel fails to evaluate. It needs no npm dependency (registration is a pure top-level call).

## Setup wizard

This is the zero-friction part. The wizard runs Photon's device-login flow, then finds/creates your project, mints the project secret, registers your phone, and surfaces the iMessage number you'll text — writing `PHOTON_PROJECT_ID` + `PHOTON_PROJECT_SECRET` to `.env` for you.

```bash
pnpm exec tsx scripts/photon-setup.ts --phone +15551234567
```

Replace `+15551234567` with your own iMessage phone number in E.164 format. Omit `--phone` to be prompted (interactive terminals only).

The wizard prints a URL and a code:

> Tell the user:
>
> 1. Open the printed URL (`https://app.photon.codes/...`) in a browser
> 2. Approve the device and enter the code shown
> 3. The wizard finishes automatically once you approve

When it completes it prints **your agent's iMessage number** — the number to text from your phone to reach the agent. It's also saved to `data/photon-auth.json`.

Flags: `--project-name <name>` (default `NanoClaw`), `--no-browser` (print the URL instead of auto-opening), `--non-interactive` (fail instead of prompting), `--dashboard-host` / `--spectrum-host` (override the Photon API hosts).

Check state any time:

```bash
pnpm exec tsx scripts/photon-setup.ts status
```

## Restart the service

So the adapter picks up the new credentials and connects:

```bash
source setup/lib/install-slug.sh
# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
# Linux
systemctl --user restart $(systemd_unit)
```

Confirm it connected:

```bash
grep "Photon channel connected" logs/nanoclaw.log | tail -1
```

## Wiring

Text your agent's iMessage number once from your phone. The router auto-creates a `messaging_groups` row for the DM. Then wire it to an agent — the wizard prints a ready-to-run command using your phone number:

```bash
npx tsx scripts/init-first-agent.ts \
  --channel imessage-cloud \
  --user-id imessage-cloud:+15551234567 \
  --platform-id +15551234567 \
  --display-name "You"
```

DMs are direct-addressable: the DM `platform_id` is your bare E.164 number (e.g. `+15551234567`), and your user id is `imessage-cloud:+15551234567`. Or run `/init-first-agent` / `/manage-channels` interactively.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise, run `/init-first-agent` to stand up an agent on your iMessage DM, or `/manage-channels` to wire it to an existing agent group.

## Channel Info

- **type**: `imessage-cloud`
- **terminology**: iMessage has 1:1 "chats" (DMs) and group chats. Photon calls each conversation a "space".
- **platform-id-format**:
  - DM: your E.164 phone number (e.g. `+15551234567`) — direct-addressable, no channel prefix
  - Group: the opaque Spectrum space id
- **how-to-find-id**: DMs use the counterpart's phone number. Groups are discovered on first message — `pnpm exec tsx scripts/q.ts data/v2.db "SELECT platform_id, name FROM messaging_groups WHERE channel_type='imessage-cloud'"`
- **supports-threads**: no
- **typical-use**: Personal assistant over iMessage DMs, or small group chats
- **default-isolation**: One agent per Photon project. Multiple DMs with the same operator can share an agent group; groups with other people should typically use `isolated` session mode.

### Features

- Markdown formatting — sent natively (`PHOTON_MARKDOWN=false` to strip to plain text)
- File attachments — send and receive images, video, audio, documents (inbound cached to `data/attachments/`, capped by `PHOTON_MAX_INLINE_ATTACHMENT_BYTES`, default 20 MB)
- Reactions (tapbacks) — `send_reaction` maps to an iMessage tapback; inbound tapbacks arrive as `reaction:added:<emoji>`
- Read receipts — inbound messages mark their iMessage chat read; receipt failures do not block routing
- Approval questions — `ask_user_question` renders as text with `/approve`, `/reject` slash-command replies (iMessage has no buttons)
- Typing indicators — sent while the agent works

### Optional `.env` settings

```bash
# Send replies as plain text instead of markdown
PHOTON_MARKDOWN=false
# Enable Spectrum SDK telemetry (default off)
PHOTON_TELEMETRY=false
# Max inbound attachment bytes the adapter reads + caches (default 20 MB)
PHOTON_MAX_INLINE_ATTACHMENT_BYTES=20971520
# Override Photon API hosts (rarely needed)
PHOTON_DASHBOARD_HOST=https://app.photon.codes
PHOTON_SPECTRUM_HOST=https://spectrum.photon.codes
```

## Troubleshooting

### `spectrum-ts` is not installed

The channel logs an error at setup and stays offline. Run step 4 (`pnpm install spectrum-ts@8.0.0`) and restart.

### Bot not responding

1. Adapter connected: `grep "Photon channel connected" logs/nanoclaw.log | tail -1`
2. Credentials present: `pnpm exec tsx scripts/photon-setup.ts status`
3. Channel wired: `pnpm exec tsx scripts/q.ts data/v2.db "SELECT mg.platform_id, mg.name FROM messaging_groups mg JOIN messaging_group_agents mga ON mg.id=mga.messaging_group_id WHERE mg.channel_type='imessage-cloud'"`
4. Service running: `systemctl --user status "$(. setup/lib/install-slug.sh && systemd_unit)"` (Linux) / `launchctl print gui/$(id -u)/"$(. setup/lib/install-slug.sh && launchd_label)"` (macOS)

### Device login times out

The code expires after ~30 minutes. Re-run `pnpm exec tsx scripts/photon-setup.ts` — a stored, still-valid token is reused, so a partial setup finishes cleanly.

### No iMessage line assigned

On a fresh project the shared line can take a moment to attach. Re-run `pnpm exec tsx scripts/photon-setup.ts status`, or check the [Photon dashboard](https://app.photon.codes). Text the surfaced number once you have it.

### Inbound messages stop arriving

The adapter re-subscribes to the gRPC stream automatically with backoff. If it persists, it's usually upstream (Photon Spectrum) — restart the service to force a fresh stream, and check the Photon status page.

## Upgrading spectrum-ts

`spectrum-ts` is pinned exactly because it ships breaking majors. To upgrade: read the [SDK release notes](https://github.com/photon-hq/spectrum-ts/releases) for every version between the current pin and the target, bump the pin in `package.json`, reconcile `src/channels/imessage-cloud.ts` against the new typings (the adapter uses `Spectrum`, `imessage`, `text`/`markdown`/`typing`/`read`/`attachment`/`voice`, and `space.send`/`space.getMessage`/`react`), then run `pnpm run build` and `pnpm exec vitest run src/channels/imessage-cloud.test.ts`.

See [docs/imessage-cloud.md](../../docs/imessage-cloud.md) for the full channel reference.
