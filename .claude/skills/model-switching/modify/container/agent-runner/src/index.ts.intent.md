# Intent: container/agent-runner/src/index.ts — Use Model in Agent

## What Changes

Three changes to the agent-runner so it uses the model selected by the user:

1. Add `model?: string` to the `ContainerInput` interface
2. Pass `containerInput.model` to the SDK's `options.model`
3. Inject a `[SYSTEM: ...]` line into the prompt so the agent knows which model it's running on

## Change 1: ContainerInput Interface

Add `model` to the interface near the top of the file:

```typescript
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  model?: string;          // <-- ADD THIS
  secrets?: Record<string, string>;
}
```

## Change 2: Pass Model to SDK

In the `runQuery()` function, the `query()` call already has an `options` object. Add `model: containerInput.model` to it:

```typescript
for await (const message of query({
  prompt: stream,
  options: {
    model: containerInput.model,   // <-- ADD THIS
    cwd: '/workspace/group',
    // ... rest of existing options
  }
})) {
```

## Change 3: Inject Model into Prompt

In the `main()` function, before the query loop, prepend the model info to the initial prompt. Place this after reading stdin but before the query loop:

```typescript
// Build initial prompt (drain any pending IPC messages too)
let prompt = '';
if (containerInput.model) {
  prompt += `[SYSTEM: You are running on model ${containerInput.model}]\n\n`;
}
prompt += containerInput.prompt;
```

This goes in `main()` where the initial prompt is assembled, before any IPC messages are drained.

## Why the System Line

The Claude Agent SDK doesn't expose the model to the running agent. Without this injection, the agent has no way to tell the user which model it's running on when asked. The `[SYSTEM: ...]` prefix is a convention the agent recognizes as metadata, not user content.

## Invariants

- `model` is optional — when undefined, the SDK uses its default and no system line is injected
- The `[SYSTEM: ...]` line must come before the user's prompt content
- Do NOT modify any other SDK options (allowedTools, permissionMode, etc.)
- The model line is only injected into the initial prompt, not follow-up IPC messages
