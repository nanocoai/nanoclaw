# Intent: src/db.ts — Model Override Persistence

## What Changes

Add two accessor functions for reading/writing the model override. These use the existing `router_state` table — no schema changes needed.

## Where to Add

After the existing `setRouterState()` function (around the "Router state accessors" section), add:

```typescript
// --- Model override accessors ---

export function getModelOverride(): string | undefined {
  return getRouterState('model_override') || undefined;
}

export function setModelOverride(model: string): void {
  setRouterState('model_override', model);
}
```

## Invariants

- Do NOT modify the `router_state` table schema — it already has `key TEXT PRIMARY KEY, value TEXT NOT NULL`
- Do NOT modify any existing functions
- The model override is stored as `key = 'model_override'` in the `router_state` table
- `getModelOverride()` returns `undefined` (not `null`) when no override is set, matching the pattern used by `getRouterState()`
