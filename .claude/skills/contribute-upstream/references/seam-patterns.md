# Seam patterns: generic base upstream, full control locally

Every local feature splits into two parts:

- **Base**: the generic mechanism. No install-specific names, hosts, models, or policies. It is
  what could live in upstream NanoClaw. Its default behavior must equal upstream's current
  behavior, so shipping the seam alone changes nothing for anyone.
- **Override**: this install's policy, kept in the fork's local code folder (for example
  `src/local/` or `container/agent-runner/src/local/`). It plugs into the base through the seam
  and never edits an upstream file beyond one registration line.

Pick the pattern by what the local code needs to change. Prefer the first one that fits.

| # | Pattern | Use when the local code needs to… | Example shape |
|---|---------|-----------------------------------|---------------|
| P1 | Registry | add one more thing of a known kind | `registerDeliveryAction`, channel/provider barrels |
| P2 | Strategy with default | replace one decision (who runs next, how to render) | gateway provider selected by `NANOCLAW_GATEWAY_PROVIDER` |
| P3 | Decorator / wrapper | add behavior around an existing implementation | a provider wrapper that retries on a second model |
| P4 | Lifecycle hooks | observe or adjust steps inside a loop | `beforeTurn` / `afterTurn` hooks around the poll loop |
| P5 | Open data field | carry extra per-item data through a pipeline | an opaque JSON field on a task that core passes through |

## Rules (SOLID applied to the seam)

1. **Single responsibility.** One seam per decision. A scheduler seam decides admission. It does
   not also render cards.
2. **Open/closed.** The base is closed once merged. The override extends it by registering, never
   by patching the base file.
3. **Liskov.** The upstream default and the local override satisfy the same interface and the same
   contract (return shape, error behavior, timing). A caller cannot tell which one is installed.
4. **Interface segregation.** Small interfaces. Optional methods over one fat interface
   (`beforeTurn?`, `afterTurn?`), so an override implements only what it needs.
5. **Dependency inversion.** Upstream code depends on the interface and a registry lookup, never on
   local-folder imports. Local code depends on upstream, never the reverse.

A seam PR is **behavior-neutral**: default implementation = today's upstream code path, plus a
registration test proving an override is picked up. That keeps it inside CONTRIBUTING's accepted
"simplifications / refactor" scope (`kind/cleanup`).

## Worked example: scheduler admission

Situation: a fork caps how many scheduled tasks run in parallel and orders them by priority. The
policy is edited directly into several upstream files, and every upstream update conflicts there.

**Base (upstream PR, behavior-neutral):**

```ts
// src/modules/scheduling/admission.ts
export interface SchedulerAdmission {
  shouldWake(candidate: DueTaskSession): Promise<boolean>;
  onSessionIdle?(session: SessionRef): Promise<void>;
}

const admitAll: SchedulerAdmission = { shouldWake: async () => true };
let active: SchedulerAdmission = admitAll;

export function registerSchedulerAdmission(admission: SchedulerAdmission): void {
  active = admission;
}

export function schedulerAdmission(): SchedulerAdmission {
  return active;
}
```

The wake site calls `schedulerAdmission().shouldWake(...)` where it wakes today. The default admits
everything, which is exactly current behavior. Task priority travels in an open data field (P5), so
upstream only needs to pass it through, not understand it.

**Override (local, zero upstream lines beyond one registration):**

```ts
// src/local/scheduling/scheduler-gate.ts
registerSchedulerAdmission({
  shouldWake: (candidate) => capAndPriority(candidate),
  onSessionIdle: releaseIdleSchedulerSlot,
});
```

The local code keeps every policy decision: cap, priority order, idle eviction. It can be
rewritten at will without touching upstream, and a future upstream refactor of the wake site
cannot conflict with it.

## Mapping a feature to a pattern

1. List every upstream file the feature edits (inventory "Upstream files edited", plus the
   divergence entry when the fork keeps a divergences file).
2. For each edit, name the decision it changes. Same decision in several files → one seam.
3. Choose P1–P5 per decision. Write the interface first, then the default that reproduces
   upstream exactly.
4. Check the override needs nothing the interface does not pass. If it does, widen the interface
   now. An override that reaches around the seam is a future conflict.
5. Record the plan in the ledger row: `route: seam`, the pattern, and the target interface name.
