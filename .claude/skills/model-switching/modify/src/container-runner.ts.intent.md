# Intent: src/container-runner.ts — Pass Model to Container

## What Changes

Add `model?: string` to the `ContainerInput` interface so the host can pass the user's model selection to the container.

## Where to Add

In the `ContainerInput` interface, add the `model` field:

```typescript
export interface ContainerInput {
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

## Invariants

- The field is optional (`model?: string`) — when undefined, the SDK uses its default model
- No other changes to this file are needed — the model value flows through the existing stdin JSON protocol to the container
- The `secrets` field must remain last (it's deleted after writing to stdin for security)
