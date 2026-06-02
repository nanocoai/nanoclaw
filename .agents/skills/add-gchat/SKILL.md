---
name: add-gchat
description: Add Google Chat channel integration via Chat SDK.
---

# Add Google Chat Channel

Adds Google Chat support via the Chat SDK bridge.

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the Google Chat adapter in from the `channels` branch.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/gchat.ts` exists
- `src/channels/index.ts` contains `import './gchat.js';`
- `@chat-adapter/gchat` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter

```bash
git show origin/channels:src/channels/gchat.ts > src/channels/gchat.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './gchat.js';
```

### 4. Install the adapter package (pinned)

```bash
pnpm install @chat-adapter/gchat@4.27.0
```

### 5. Build

```bash
pnpm run build
```

## Credentials

> 1. Go to [Google Cloud Console](https://console.cloud.google.com)
> 2. Create or select a project
> 3. Enable the **Google Chat API**
> 4. Go to **Google Chat API** > **Configuration**:
>    - App name and description
>    - Connection settings: select **HTTP endpoint URL** and set to `https://your-domain/webhook/gchat`
> 5. Create a **Service Account**:
>    - Go to **IAM & Admin** > **Service Accounts** > **Create Service Account**
>    - Grant the Chat Bot role
>    - Create a JSON key and download it

### Configure environment

Add the service account JSON as a single-line string to `.env`:

```bash
GCHAT_CREDENTIALS={"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `gchat`
- **terminology**: Google Chat has "spaces." A space can be a group conversation or a direct message with the bot.
- **how-to-find-id**: Open the space in Google Chat, look at the URL — the space ID is the segment after `/space/` (e.g. `spaces/AAAA...`). Or use the Google Chat API to list spaces.
- **supports-threads**: yes
- **typical-use**: Interactive chat — team spaces or direct messages
- **default-isolation**: Same agent group for spaces where you're the primary user. Separate agent group for spaces with different teams or sensitive contexts.
