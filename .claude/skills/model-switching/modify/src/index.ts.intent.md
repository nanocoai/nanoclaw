# Intent: src/index.ts — Command Handling and Interception

## What Changes

This is the largest modification. It adds:
1. Model name mapping constants
2. Three helper functions
3. New imports from `./db.js`
4. Model override passed to container input
5. `/model` interception in **two** message processing paths

## Change 1: Imports

Add `getModelOverride`, `setModelOverride`, and `clearAllSessions` to the import from `./db.js`:

```typescript
import {
  clearAllSessions,
  // ... existing imports ...
  getModelOverride,
  // ... existing imports ...
  setModelOverride,
  // ... existing imports ...
} from './db.js';
```

## Change 2: Model Constants and Functions

Add these after the imports but before any state variables (`let lastTimestamp`, etc.):

```typescript
// Model name -> model ID mapping
// IDs must match what the Claude CLI in the container actually supports
const MODEL_MAP: Record<string, Record<string, string>> = {
  haiku:  { '4.5': 'claude-haiku-4-5-20251001' },
  sonnet: { '4': 'claude-sonnet-4-20250514', '4.5': 'claude-sonnet-4-5-20250929', '4.6': 'claude-sonnet-4-6' },
  opus:   { '4': 'claude-opus-4-20250514', '4.5': 'claude-opus-4-5-20251101', '4.6': 'claude-opus-4-6' },
};

// Default (latest) version per family
const MODEL_LATEST: Record<string, string> = {
  haiku:  '4.5',
  sonnet: '4.6',
  opus:   '4.6',
};

/**
 * Resolve a friendly model name to a full model ID.
 * Accepts: "opus", "sonnet 4.5", "claude-opus-4-6-20250918", etc.
 * Returns the model ID or null if invalid.
 */
function resolveModelName(input: string): string | null {
  const trimmed = input.trim().toLowerCase();

  // Raw model ID (starts with "claude-") -- pass through directly
  if (trimmed.startsWith('claude-')) return trimmed;

  const parts = trimmed.split(/\s+/);
  const family = parts[0];
  const version = parts[1];

  if (!MODEL_MAP[family]) return null;

  if (version) {
    // Specific version: "sonnet 4.5"
    return MODEL_MAP[family][version] || null;
  }

  // No version -- use latest
  const latestVersion = MODEL_LATEST[family];
  return latestVersion ? MODEL_MAP[family][latestVersion] : null;
}

/** Get a display-friendly name for a model ID */
function friendlyModelName(modelId: string): string {
  for (const [family, versions] of Object.entries(MODEL_MAP)) {
    for (const [ver, id] of Object.entries(versions)) {
      if (id === modelId) return `${family} ${ver}`;
    }
  }
  return modelId; // Raw ID, no friendly name
}

/**
 * Handle a /model command. Returns the response to the user.
 * Extracted so both processGroupMessages and startMessageLoop can use it.
 */
async function handleModelCommand(
  content: string,
  chatJid: string,
  channel: Channel,
): Promise<void> {
  const args = content.trim().replace(/^\/model\s*/i, '').trim();
  const families = Object.keys(MODEL_MAP).join(', ');

  if (!args) {
    const current = getModelOverride();
    const display = current ? friendlyModelName(current) : 'sonnet (default)';
    await channel.sendMessage(chatJid, `Current model: *${display}*`);
  } else {
    const resolved = resolveModelName(args);
    if (resolved) {
      setModelOverride(resolved);
      // Close any active container so the next message spawns one with the new model
      queue.closeStdin(chatJid);
      // Clear all sessions so the SDK starts fresh with the new model
      // (resumed sessions lock to their original model)
      sessions = {};
      clearAllSessions();
      await channel.sendMessage(chatJid, `Model switched to *${friendlyModelName(resolved)}* (${resolved})`);
      logger.info({ model: resolved }, 'Model override set');
    } else {
      await channel.sendMessage(
        chatJid,
        `Unknown model "${args}". Available: ${families}, or a raw model ID (claude-...)`,
      );
    }
  }
}
```

**Important**: `handleModelCommand` references `queue`, `sessions`, and `logger` which are module-level variables. It must be placed after the imports but can be before or after the state variable declarations as long as it's in the same module scope.

## Change 3: Pass Model to Container

In the `runAgent()` function, add `model: getModelOverride()` to the `ContainerInput` object passed to `runContainerAgent()`:

```typescript
const output = await runContainerAgent(
  group,
  {
    prompt,
    sessionId,
    groupFolder: group.folder,
    chatJid,
    isMain,
    model: getModelOverride(),   // <-- ADD THIS
  },
  // ... rest of args
);
```

## Change 4: Intercept in processGroupMessages()

In `processGroupMessages()`, add `/model` interception **before** the trigger check and prompt formatting. Place it after getting `missedMessages` but before the trigger pattern check:

```typescript
// Intercept /model commands before they reach the agent
const modelMsg = missedMessages.find((m) => /^\/model\b/i.test(m.content.trim()));
if (modelMsg) {
  await handleModelCommand(modelMsg.content, chatJid, channel);
  lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1].timestamp;
  saveState();
  return true;
}
```

## Change 5: Intercept in startMessageLoop()

In `startMessageLoop()`, add `/model` interception inside the `for (const [chatJid, groupMessages])` loop, **after** the trigger check but **before** pulling pending messages and sending to the container:

```typescript
// Intercept /model commands before they reach the agent
const modelCmd = groupMessages.find((m) => /^\/model\b/i.test(m.content.trim()));
if (modelCmd) {
  await handleModelCommand(modelCmd.content, chatJid, channel);
  lastAgentTimestamp[chatJid] = groupMessages[groupMessages.length - 1].timestamp;
  saveState();
  continue;
}
```

## Critical: Why Both Paths

Messages can reach the agent via two paths:
1. **processGroupMessages** — called by GroupQueue when spawning a new container
2. **startMessageLoop** — the polling loop that can pipe messages to an active container via `queue.sendMessage()`

If you only intercept in one path, `/model` will sometimes be sent to the agent as a regular message instead of being handled as a command. Both interception points must exist.

## Critical: Session Clearing

When switching models, `handleModelCommand` must:
1. Call `queue.closeStdin(chatJid)` to close the active container
2. Reset `sessions = {}` (in-memory)
3. Call `clearAllSessions()` (database)

This is because the Claude Agent SDK locks a resumed session to its original model. If you only close the container without clearing sessions, the next container will resume with the old model.

## Invariants

- Do NOT modify the trigger pattern logic, message cursor advancement, or IPC piping
- The `/model` check must use `/^\/model\b/i` (case-insensitive, word boundary) to avoid matching messages that start with "model"
- `handleModelCommand` must advance `lastAgentTimestamp` and call `saveState()` so the command message isn't reprocessed
- In `processGroupMessages`, return `true` after handling (success, don't retry)
- In `startMessageLoop`, use `continue` after handling (skip to next group)
