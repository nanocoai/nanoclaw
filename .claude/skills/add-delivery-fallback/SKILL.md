---
name: add-delivery-fallback
description: Add an opt-in delivery fallback. Name a preferred channel and a fallback destination; a send that fails on the preferred channel is retried once on the fallback, and approval requests prefer other channels while the preferred one is failing.
---

# Add Delivery Fallback

Keeps outbound messages and approval requests flowing when one channel is down. With no configuration it does nothing, and delivery works as before.

- **Failed send**: a send on the preferred channel type that throws is retried once, with the same content, on the fallback destination. If the retry fails too, the original error surfaces and the normal delivery retry path takes over.
- **Approvals**: after a failure on the preferred channel, approvers on that channel are tried last for a cooldown (default 60 seconds), so approval cards reach someone reachable first.

The module uses two host hooks: `registerDeliveryAdapterWrapper` (`src/delivery.ts`) and `registerApprovalDeliveryOrder` (`src/modules/approvals/primitive.ts`).

## Steps

### 1. Copy the module and its tests

```
.claude/skills/add-delivery-fallback/resources/index.ts                  → src/modules/delivery-fallback/index.ts
.claude/skills/add-delivery-fallback/resources/delivery-fallback.ts      → src/modules/delivery-fallback/delivery-fallback.ts
.claude/skills/add-delivery-fallback/resources/delivery-fallback.test.ts → src/modules/delivery-fallback/delivery-fallback.test.ts
.claude/skills/add-delivery-fallback/resources/registration.test.ts      → src/modules/delivery-fallback/registration.test.ts
```

### 2. Register the module

Append one line to the end of `src/modules/index.ts` (skip if present):

```typescript
import './delivery-fallback/index.js';
```

`registration.test.ts` imports the real barrel and drives a delivery and an approver pick through it, so it goes red if this line is deleted or the hooks move.

### 3. Configure

Add to `.env`:

```
DELIVERY_FALLBACK_FROM=<channel-type>
DELIVERY_FALLBACK_TO=<channel-type>:<platform-id>
DELIVERY_FALLBACK_COOLDOWN_MS=60000
```

`DELIVERY_FALLBACK_FROM` is the preferred channel type (for example `slack`). `DELIVERY_FALLBACK_TO` is where the retry goes: a different channel type and the platform id of the chat to send to (for example `telegram:123456`). The cooldown is optional. A config with only one of the two, or with the same channel on both sides, is ignored with a warning.

### 4. Build, test, and restart

```bash
pnpm run build
pnpm exec vitest run src/modules/delivery-fallback
```

Then restart the service (`./nanoclaw.sh`, or the launchd/systemd restart your install uses).

## Troubleshooting

- **Nothing falls back**: check the startup log for "Delivery fallback ignored" and confirm both `.env` values are set.
- **Retry lands in the wrong chat**: `DELIVERY_FALLBACK_TO` takes the platform id as the channel adapter stores it, not a display name.
- **Fallback also failing**: the original error is logged and the message follows the normal delivery retry path.

## Removal

See [REMOVE.md](REMOVE.md).
