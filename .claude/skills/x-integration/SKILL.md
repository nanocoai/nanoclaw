---
name: x-integration
description: X (Twitter) integration for NanoClaw. Post tweets, like, reply, retweet, and quote. Use for setup, testing, or troubleshooting X functionality. Triggers on "setup x", "x integration", "twitter", "post tweet", "tweet".
---

# X (Twitter) Integration

Browser automation for X interactions via WhatsApp.

> **Compatibility:** NanoClaw v1.0.0. Directory structure may change in future versions.

## Features

| Action | Tool | Description |
|--------|------|-------------|
| Post | `x_post` | Publish new tweets |
| Like | `x_like` | Like any tweet |
| Reply | `x_reply` | Reply to tweets |
| Retweet | `x_retweet` | Retweet without comment |
| Quote | `x_quote` | Quote tweet with comment |

## Prerequisites

Before using this skill, ensure:

1. **NanoClaw is installed and running** - WhatsApp connected, service active
2. **Dependencies installed**:
   ```bash
   pnpm ls playwright dotenv-cli || pnpm install playwright dotenv-cli
   ```
3. **CHROME_PATH configured** in `.env` (if Chrome is not at default location):
   ```bash
   # Find your Chrome path
   mdfind "kMDItemCFBundleIdentifier == 'com.google.Chrome'" 2>/dev/null | head -1
   # Add to .env
   CHROME_PATH=/path/to/Google Chrome.app/Contents/MacOS/Google Chrome
   ```

## Quick Start

Run from your NanoClaw project root:

```bash
# 1. Setup authentication (interactive)
pnpm exec dotenv -e .env -- pnpm exec tsx .claude/skills/x-integration/scripts/setup.ts
# Verify: data/x-auth.json should exist after successful login

# 2. Rebuild container to include skill
./container/build.sh
# Verify: Output shows "COPY .claude/skills/x-integration/agent.ts"

# 3. Rebuild host and restart service
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
# Verify: launchctl list | grep "$(launchd_label)" (macOS) or systemctl --user status $(systemd_unit) (Linux)
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHROME_PATH` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | Chrome executable path |
| `NANOCLAW_ROOT` | `process.cwd()` | Project root directory |
| `LOG_LEVEL` | `info` | Logging level (debug, info, warn, error) |

Set in `.env` file (loaded via `dotenv-cli` at runtime):

```bash
# .env
CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

### Configuration File

Edit `lib/config.ts` to modify defaults:

```typescript
export const config = {
    // Browser viewport
    viewport: { width: 1280, height: 800 },

    // Timeouts (milliseconds)
    timeouts: {
        navigation: 30000,    // Page navigation
        elementWait: 5000,    // Wait for element
        afterClick: 1000,     // Delay after click
        afterFill: 1000,      // Delay after form fill
        afterSubmit: 3000,    // Delay after submit
        pageLoad: 3000,       // Initial page load
    },

    // Tweet limits
    limits: {
        tweetMaxLength: 280,
    },
};
```

### Data Directories

Paths relative to project root:

| Path | Purpose | Git |
|------|---------|-----|
| `data/x-browser-profile/` | Chrome profile with X session | Ignored |
| `data/x-auth.json` | Auth state marker | Ignored |
| `logs/nanoclaw.log` | Service logs (contains X operation logs) | Ignored |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Container (Linux VM)                                       │
│  └── agent.ts → MCP tool definitions (x_post, etc.)    │
│      └── Writes IPC request to /workspace/ipc/tasks/       │
└──────────────────────┬──────────────────────────────────────┘
                       │ IPC (file system)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Host (macOS)                                               │
│  └── src/ipc.ts → processTaskIpc()                         │
│      └── host.ts → handleXIpc()                         │
│          └── spawn subprocess → scripts/*.ts               │
│              └── Playwright → Chrome → X Website           │
└─────────────────────────────────────────────────────────────┘
```

### Why This Design?

- **API is expensive** - X official API requires paid subscription ($100+/month) for posting
- **Bot browsers get blocked** - X detects and bans headless browsers and common automation fingerprints
- **Must use user's real browser** - Reuses the user's actual Chrome on Host with real browser fingerprint to avoid detection
- **One-time authorization** - User logs in manually once, session persists in Chrome profile for future use

### File Structure

```
.claude/skills/x-integration/
├── SKILL.md          # This documentation
├── host.ts           # Host-side IPC handler
├── agent.ts          # Container-side MCP tool definitions
├── lib/
│   ├── config.ts     # Centralized configuration
│   └── browser.ts    # Playwright utilities
└── scripts/
    ├── setup.ts      # Interactive login
    ├── post.ts       # Post tweet
    ├── like.ts       # Like tweet
    ├── reply.ts      # Reply to tweet
    ├── retweet.ts    # Retweet
    └── quote.ts      # Quote tweet
```

### Integration Points

To integrate this skill into NanoClaw, make the following modifications:

---

**1. Host side: `src/ipc.ts`**

Add import after other local imports:
```typescript
import { handleXIpc } from '../.claude/skills/x-integration/host.js';
```

Modify `processTaskIpc` function's switch statement default case:
```typescript
// Find:
default:
logger.warn({ type: data.type }, 'Unknown IPC task type');

// Replace with:
default:
const handled = await handleXIpc(data, sourceGroup, isMain, DATA_DIR);
if (!handled) {
    logger.warn({ type: data.type }, 'Unknown IPC task type');
}
```

---

**2. Container side: `container/agent-runner/src/ipc-mcp.ts`**

Add import after `cron-parser` import:
```typescript
// @ts-ignore - Copied during Docker build from .claude/skills/x-integration/
import { createXTools } from './skills/x-integration/agent.js';
```

Add to the end of tools array (before the closing `]`):
```typescript
    ...createXTools({ groupFolder, isMain })
```

---

**3. Build script: `container/build.sh`**

Change build context from `container/` to project root (required to access `.claude/skills/`):
```bash
# Find:
docker build -t "${IMAGE_NAME}:${TAG}" .

# Replace with:
cd "$SCRIPT_DIR/.."
docker build -t "${IMAGE_NAME}:${TAG}" -f container/Dockerfile .
```

---

**4. Dockerfile: `container/Dockerfile`**

First, update the build context paths (required to access `.claude/skills/` from project root):
```dockerfile
# Find:
COPY agent-runner/package*.json ./
...
COPY agent-runner/ ./

# Replace with:
COPY container/agent-runner/package*.json ./
...
COPY container/agent-runner/ ./
```

Then add COPY line after `COPY container/agent-runner/ ./` and before `RUN pnpm run build`:
```dockerfile
# Copy skill MCP tools
COPY .claude/skills/x-integration/agent.ts ./src/skills/x-integration/
```

## Setup

All paths below are relative to project root (`NANOCLAW_ROOT`).

### 1. Check Chrome Path

```bash
# Check if Chrome exists at configured path
cat .env | grep CHROME_PATH
ls -la "$(grep CHROME_PATH .env | cut -d= -f2)" 2>/dev/null || \
echo "Chrome not found - update CHROME_PATH in .env"
```

### 2. Run Authentication

```bash
pnpm exec dotenv -e .env -- pnpm exec tsx .claude/skills/x-integration/scripts/setup.ts
```

This opens Chrome for manual X login. Session saved to `data/x-browser-profile/`.

**Verify success:**
```bash
cat data/x-auth.json  # Should show {"authenticated": true, ...}
```

### 3. Rebuild Container

```bash
./container/build.sh
```

**Verify success:**
```bash
./container/build.sh 2>&1 | grep -i "agent.ts"  # Should show COPY line
```

### 4. Restart Service

Run from your NanoClaw project root:

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```

**Verify success.**

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
launchctl list | grep "$(launchd_label)"  # macOS — should show PID and exit code 0 or -
# Linux: systemctl --user status $(systemd_unit)
```

## Usage via WhatsApp

Replace `@Assistant` with your configured trigger name (`ASSISTANT_NAME` in `.env`):

```
@Assistant post a tweet: Hello world!

@Assistant like this tweet https://x.com/user/status/123

@Assistant reply to https://x.com/user/status/123 with: Great post!

@Assistant retweet https://x.com/user/status/123

@Assistant quote https://x.com/user/status/123 with comment: Interesting
```

**Note:** Only the main group can use X tools. Other groups will receive an error.

## Testing

Scripts require environment variables from `.env`. Use `dotenv-cli` to load them:

### Check Authentication Status

```bash
# Check if auth file exists and is valid
cat data/x-auth.json 2>/dev/null && echo "Auth configured" || echo "Auth not configured"

# Check if browser profile exists
ls -la data/x-browser-profile/ 2>/dev/null | head -5
```

### Re-authenticate (if expired)

```bash
pnpm exec dotenv -e .env -- pnpm exec tsx .claude/skills/x-integration/scripts/setup.ts
```

### Test Post (will actually post)

```bash
echo '{"content":"Test tweet - please ignore"}' | pnpm exec dotenv -e .env -- pnpm exec tsx .claude/skills/x-integration/scripts/post.ts
```

### Test Like

```bash
echo '{"tweetUrl":"https://x.com/user/status/123"}' | pnpm exec dotenv -e .env -- pnpm exec tsx .claude/skills/x-integration/scripts/like.ts
```

Or export `CHROME_PATH` manually before running:

```bash
export CHROME_PATH="/path/to/chrome"
echo '{"content":"Test"}' | pnpm exec tsx .claude/skills/x-integration/scripts/post.ts
```

## Troubleshooting

### Authentication Expired

Run from your NanoClaw project root:

```bash
pnpm exec dotenv -e .env -- pnpm exec tsx .claude/skills/x-integration/scripts/setup.ts
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```

### Browser Lock Files

If Chrome fails to launch:

```bash
rm -f data/x-browser-profile/SingletonLock
rm -f data/x-browser-profile/SingletonSocket
rm -f data/x-browser-profile/SingletonCookie
```

### Check Logs

```bash
# Host logs (relative to project root)
grep -i "x_post\|x_like\|x_reply\|handleXIpc" logs/nanoclaw.log | tail -20

# Script errors
grep -i "error\|failed" logs/nanoclaw.log | tail -20
```

### Script Timeout

Default timeout is 2 minutes (120s). Increase in `host.ts`:

```typescript
const timer = setTimeout(() => {
  proc.kill('SIGTERM');
  resolve({ success: false, message: 'Script timed out (120s)' });
}, 120000);  // ← Increase this value
```

### X UI Selector Changes

If X updates their UI, selectors in scripts may break. Current selectors:

| Element | Selector |
|---------|----------|
| Tweet input | `[data-testid="tweetTextarea_0"]` |
| Post button | `[data-testid="tweetButtonInline"]` |
| Reply button | `[data-testid="reply"]` |
| Like | `[data-testid="like"]` |
| Unlike | `[data-testid="unlike"]` |
| Retweet | `[data-testid="retweet"]` |
| Unretweet | `[data-testid="unretweet"]` |
| Confirm retweet | `[data-testid="retweetConfirm"]` |
| Modal dialog | `[role="dialog"][aria-modal="true"]` |
| Modal submit | `[data-testid="tweetButton"]` |

### Container Build Issues

If MCP tools not found in container:

```bash
# Verify build copies skill
./container/build.sh 2>&1 | grep -i skill

# Check container has the file
docker run nanoclaw-agent ls -la /app/src/skills/
```

## Security

- `data/x-browser-profile/` - Contains X session cookies (in `.gitignore`)
- `data/x-auth.json` - Auth state marker (in `.gitignore`)
- Only main group can use X tools (enforced in `agent.ts` and `host.ts`)
- Scripts run as subprocesses with limited environment