---
name: add-imessage
description: Add iMessage channel integration via Chat SDK. Local (macOS) or remote (Photon API) mode.
---

# Add iMessage Channel

Adds iMessage support via the Chat SDK bridge. Two modes: local (macOS with Full Disk Access) or remote (Photon API).

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the iMessage adapter in from the `channels` branch.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/imessage.ts` exists
- `src/channels/index.ts` contains `import './imessage.js';`
- `chat-adapter-imessage` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter

```bash
git show origin/channels:src/channels/imessage.ts > src/channels/imessage.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './imessage.js';
```

### 4. Install the adapter package (pinned)

```bash
pnpm install chat-adapter-imessage@0.1.1
```

### 5. Build

```bash
pnpm run build
```

## Credentials

### Local Mode (macOS)

Requirements: macOS with Full Disk Access granted to the Node.js binary.

The Node binary path is buried deep (e.g. `~/.nvm/versions/node/v22.x.x/bin/node`). To make it easy, open the folder in Finder so the user can drag the file into System Settings:

```bash
open "$(dirname "$(which node)")"
```

Then tell the user:

1. Open **System Settings** > **Privacy & Security** > **Full Disk Access**
2. Click **+**, then drag the `node` file from the Finder window that just opened
3. Toggle it on

Stop and wait for the user to confirm before continuing.

### Remote Mode (Photon API)

1. Set up a [Photon](https://photon.im) account
2. Get your server URL and API key

### Configure environment

**Local mode** -- add to `.env`:

```bash
IMESSAGE_ENABLED=true
IMESSAGE_LOCAL=true
```

**Remote mode** -- add to `.env`:

```bash
IMESSAGE_LOCAL=false
IMESSAGE_SERVER_URL=https://your-photon-server.com
IMESSAGE_API_KEY=your-api-key
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `imessage`
- **terminology**: iMessage has "conversations." Each conversation is with a contact identified by phone number or email address. Group chats are also supported.
- **how-to-find-id**: The platform ID is the contact's phone number (e.g. `+15551234567`) or email address. For group chats, the ID is assigned by iMessage internally.
- **supports-threads**: no
- **typical-use**: Interactive 1:1 chat — personal messaging
- **default-isolation**: Same agent group if you're the only person messaging the bot across iMessage and other channels. Separate agent group if different contacts should have information isolation.
