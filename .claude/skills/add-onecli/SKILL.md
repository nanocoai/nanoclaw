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

This integration supports exactly the gateway version pinned in `.claude/skills/add-onecli/versions.json` (`onecli-gateway`, today 1.42.0; not the `versions.json` at the project root). OneCLI 1.43 and later remove the agent secret-assignment API used below, so 1.43+ is not supported for now. Setup reuses an existing gateway without checking its version: follow [Upgrading the OneCLI gateway](payload/docs/onecli-upgrades.md) to check it and to move it to the pin. The CLI (`onecli-cli`) and SDK (`onecli-sdk`) have their own pins.

```nc:run effect:external
pnpm exec tsx .claude/skills/add-onecli/scripts/setup.ts
```

## Provider credentials

Provider skills such as `/add-opencode` store model credentials here through the
gateway seam. OneCLI does not grant them automatically: grant the group's OneCLI
agent access to the chosen secret. Read its existing secret assignments first and
merge the new secret ID into that list, because `onecli agents set-secrets`
replaces assignments. Verify the result with `onecli agents secrets`. Do not put
a key in `.env`, command arguments, or the container environment.

- Only a selected OneCLI adapter uses `ONECLI_URL` and `ONECLI_API_KEY`.
- Moving an API key to another exact host keeps its stored value, so a blank
  answer at the key prompt completes the move after confirmation.
- Existing OneCLI credential names and formats remain compatible.
- ChatGPT logins need manual reauthentication after expiry on the pinned
  OneCLI 1.42.0; see [ChatGPT OAuth refresh](references/chatgpt-oauth-refresh.md)
  for the limitation and upgrade constraints.

## Validate

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/gateway-providers/onecli-files.test.ts src/gateway-providers/onecli-install.test.ts src/gateway-providers/onecli.test.ts src/gateway-providers/gateway-provider-registry.test.ts src/gateway-approval-coordinator.test.ts
```

The setup consumer writes `NANOCLAW_GATEWAY_PROVIDER=onecli` only after every directive above succeeds. Claude authentication is then completed through `scripts/auth.ts`; credentials never enter an agent container.

During an atomic NanoClaw upgrade, `scripts/detect.ts` identifies an older implicit OneCLI installation so the generic updater can preserve that choice before the service restarts.
