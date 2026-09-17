---
name: add-model-identity
description: Add model self-identification to NanoClaw agents. Enables agents to correctly answer "what model are you?" by injecting model identity into the system prompt.
---

# Add Model Self-Identification

This skill enables NanoClaw agents to accurately identify which Claude model they're running on. Without this, agents respond based on training data rather than the actual model in use.

The Claude Agent SDK doesn't provide built-in model introspection, so we pass model identity via the `systemPrompt` option as recommended in the SDK documentation.

## Implementation

### Step 1: Add Model Configuration

Read `src/config.ts` and add the CLAUDE_MODEL export at the end of the file:

```typescript
// --- Claude model configuration ---
// Default to Sonnet for speed/cost, can override with Opus for complex tasks
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';
```

### Step 2: Update Container Input Interfaces

The `ContainerInput` interface is defined in two places. Update both.

**First**, read `src/container-runner.ts` and find the exported `ContainerInput` interface. Add the `model` field:

```typescript
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
  model?: string;  // Add this line
}
```

**Second**, read `container/agent-runner/src/index.ts` and find the `ContainerInput` interface. Add the same `model` field:

```typescript
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
  model?: string;  // Add this line
}
```

### Step 3: Add Model Parsing Function

In `container/agent-runner/src/index.ts`, add the model parsing function. Place it before the `runQuery` function:

```typescript
/**
 * Parse model ID to human-readable name.
 * Example: claude-sonnet-4-5-20250929 -> Claude Sonnet 4.5
 */
function parseModelName(modelId: string): string {
  const match = modelId.match(/^claude-(\w+)-(\d+)-(\d+)/);
  if (match) {
    const [, tier, major, minor] = match;
    const tierName = tier.charAt(0).toUpperCase() + tier.slice(1);
    return `Claude ${tierName} ${major}.${minor}`;
  }
  return modelId;
}
```

### Step 4: Inject Model Identity into System Prompt

In `container/agent-runner/src/index.ts`, find the `runQuery` function. Locate where `globalClaudeMd` is loaded and the `systemPrompt` option is set.

Replace the systemPrompt construction. Find code like:

```typescript
systemPrompt: globalClaudeMd
  ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
  : undefined,
```

And update it to include model identity:

```typescript
// Build system prompt append with model identity
const modelName = containerInput.model ? parseModelName(containerInput.model) : undefined;
const modelIdentity = modelName
  ? `\n\n# Model Identity\nYou are ${modelName} (model ID: ${containerInput.model}). When asked what model you are, always respond with "${modelName}".\n`
  : '';
const systemPromptAppend = (globalClaudeMd || '') + modelIdentity;
```

Then update the query options:

```typescript
systemPrompt: systemPromptAppend
  ? { type: 'preset' as const, preset: 'claude_code' as const, append: systemPromptAppend }
  : undefined,
model: containerInput.model,
```

### Step 5: Pass Model to Container

Read `src/index.ts` and find the `runAgent` function. Locate where `runContainerAgent` is called. Add `model: CLAUDE_MODEL` to the input object.

First, add the import at the top of the file:

```typescript
import {
  // ... existing imports ...
  CLAUDE_MODEL,  // Add this
} from './config.js';
```

Then find the `runContainerAgent` call and add the model field:

```typescript
const output = await runContainerAgent(
  group,
  {
    prompt,
    sessionId,
    groupFolder: group.folder,
    chatJid,
    isMain,
    model: CLAUDE_MODEL,  // Add this line
  },
  // ... rest of the call
);
```

### Step 6: Build and Test

Build the project:

```bash
npm run build
```

Rebuild the container:

```bash
./container/build.sh
```

---

## Verification

After applying the changes, test by sending a message to the agent:

> What model are you?

The agent should respond with something like:

> I am Claude Sonnet 4.5

Instead of a generic response based on training data.

---

## Configuration

Override the default model via environment variable:

```bash
# Use Opus for complex tasks
export CLAUDE_MODEL=claude-opus-4-5-20250514

# Use Haiku for simple/fast tasks
export CLAUDE_MODEL=claude-haiku-4-5-20250514
```

The model ID format `claude-{tier}-{major}-{minor}-{date}` is parsed to display as `Claude {Tier} {major}.{minor}`.

---

## Troubleshooting

### Agent still responds with wrong model

1. Verify the container was rebuilt after changes: `./container/build.sh`
2. Check that `CLAUDE_MODEL` is exported in config.ts
3. Verify the model is passed through to the agent-runner

### Build errors

If TypeScript compilation fails, ensure:
- The `model` field is added to BOTH ContainerInput interfaces (in `src/container-runner.ts` AND `container/agent-runner/src/index.ts`)
- The import of `CLAUDE_MODEL` is added to src/index.ts
- The `parseModelName` function is defined before it's used
