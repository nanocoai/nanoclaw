---
name: add-onecli
description: Install or refresh OneCLI as NanoClaw's gateway provider. Use when setup selects OneCLI, an existing OneCLI-backed install is migrated to the gateway seam, or its runtime, approval bridge, setup, and agent guidance must be restored from the in-tree package.
---

# Add OneCLI gateway

This skill owns the full OneCLI integration. NanoClaw core supplies the generic gateway seam and existing skill engine.

## Install the provider payload

Copy the package's native adapter, tests, and agent guidance into their normal NanoClaw paths. NanoClaw core owns the approval workflow.

```nc:copy
payload/src/gateway-providers/onecli-files.ts -> src/gateway-providers/onecli-files.ts
payload/src/gateway-providers/onecli-files.test.ts -> src/gateway-providers/onecli-files.test.ts
payload/src/gateway-providers/onecli.ts -> src/gateway-providers/onecli.ts
payload/src/gateway-providers/onecli.test.ts -> src/gateway-providers/onecli.test.ts
payload/src/gateway-providers/onecli-install.test.ts -> src/gateway-providers/onecli-install.test.ts
payload/container/skills/onecli-gateway/SKILL.md -> container/skills/onecli-gateway/SKILL.md
payload/container/skills/onecli-gateway/instructions.md -> container/skills/onecli-gateway/instructions.md
payload/docs/onecli-upgrades.md -> docs/onecli-upgrades.md
```

## Register once

The provider file makes the only product registration call. It translates OneCLI sessions and native approval events into the generic contract.

```nc:append to:src/gateway-providers/installed.ts
import './onecli.js';
```

## Install the pinned SDK

```nc:dep manager:pnpm
@onecli-sh/sdk@2.2.1
```

## Configure the gateway

The setup script safely reuses a healthy existing installation, installs the pinned local gateway when absent, or uses `NANOCLAW_ONECLI_API_HOST` and `NANOCLAW_ONECLI_API_TOKEN` for a remote gateway.

```nc:run effect:external
pnpm exec tsx .claude/skills/add-onecli/scripts/setup.ts
```

## Validate

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/gateway-providers/onecli-files.test.ts src/gateway-providers/onecli-install.test.ts src/gateway-providers/onecli.test.ts src/gateway-providers/gateway-provider-registry.test.ts src/gateway-approval-coordinator.test.ts
```

The setup consumer writes `NANOCLAW_GATEWAY_PROVIDER=onecli` only after every directive above succeeds. Claude authentication is then completed through `scripts/auth.ts`; credentials never enter an agent container.

## Provider credential limits

`scripts/provider-credentials.ts` stores caller-described credentials (for example OpenCode keys) through the gateway seam's `connection()`. Before `keep()` or `save()` writes, it rereads the entry and refuses a changed ID, a duplicate, or unexpected metadata (type, host, scope, source, injection, OAuth auth mode). Other changes pass, for example a different ChatGPT account on the same entry. The reread is not atomic with the write, and it cannot detect a value rotated by someone else: OneCLI's secret list has no revision or update time, and its `PATCH` has no compare-and-set. `save()` overwrites a concurrent value change with the setup value; `keep()` leaves the value alone. Avoid editing the same OneCLI secret while setup is running.

During an atomic NanoClaw upgrade, `scripts/detect.ts` identifies an older implicit OneCLI installation so the generic updater can preserve that choice before the service restarts.
