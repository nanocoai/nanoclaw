---
name: add-model-use-cases
description: Let agent groups name a model by role (`--model usecase:coding`) and map each role to a model once in `.env`. Use when several groups should share one model choice per kind of work, so swapping that model is one `.env` line instead of an `ncl` call per group.
---

# Add Model Use Cases

Adds named model roles. A group's model can be `usecase:<name>` instead of a model id:

```bash
ncl groups config update --id <group-id> --model usecase:coding
```

The host resolves the token every time it writes the group's `container.json`, from one variable per use case:

```bash
NANOCLAW_USE_CASE_MODEL_CODING=claude-opus-4-1
NANOCLAW_USE_CASE_MODEL_FAST=claude-haiku-4-5
```

Use case names are lowercase letters, digits and `-` (`deep-think` reads `NANOCLAW_USE_CASE_MODEL_DEEP_THINK`). The value is whatever the group's provider accepts as a model: an alias, a full id, or a gateway-routed name. `NANOCLAW_DEFAULT_MODEL` may also be a `usecase:` token.

An unconfigured or malformed token logs a warning and leaves the model unset, so the provider uses its default. The token itself never reaches a provider.

## Integration test

`src/model-use-cases.test.ts` drives `configFromDb` with the token stored on a real test DB row and asserts the resolved model. It goes red if the call in `src/container-config.ts` is deleted or bypassed.

## Step 1 — Pre-flight

```bash
test -f src/model-use-cases.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Step 4.

## Step 2 — Copy the resolver and its test

```bash
cp .claude/skills/add-model-use-cases/model-use-cases.ts src/model-use-cases.ts
cp .claude/skills/add-model-use-cases/model-use-cases.test.ts src/model-use-cases.test.ts
```

## Step 3 — Wire it into `src/container-config.ts`

Add the import next to the other local imports at the top of the file:

```ts
import { resolveModelUseCase } from './model-use-cases.js';
```

In `configFromDb`, wrap the existing `model:` value in one call. The line reads:

```ts
    model: row.model ?? (DEFAULT_MODEL || undefined),
```

Change it to:

```ts
    model: resolveModelUseCase(row.model ?? (DEFAULT_MODEL || undefined), group.name),
```

Keep the comment above the line. If the line has a different shape on this checkout, wrap whatever expression yields the group's model, keeping `group.name` as the second argument.

## Step 4 — Build and test

```bash
pnpm run build
pnpm exec vitest run src/model-use-cases.test.ts
```

Both must pass.

## Step 5 — Configure

Ask the operator which use cases they want and which model each maps to. Add one line per use case to `.env`:

```bash
NANOCLAW_USE_CASE_MODEL_<NAME>=<model>
```

Then point groups at them:

```bash
ncl groups config update --id <group-id> --model usecase:<name>
```

Restart the service so the host build is live (see `CLAUDE.md` Service management). A changed `.env` value needs no service restart: the host reads it at each spawn. Restart a running group to pick it up now:

```bash
ncl groups restart --id <group-id>
```

## Verify

```bash
ncl groups restart --id <group-id> --message "Which model are you running on?"
grep '"model"' groups/<folder>/container.json
```

`container.json` holds the resolved model, never the `usecase:` token. A token there means the wiring in Step 3 is missing.

## Troubleshooting

- **The group runs the provider default:** the host log shows `Model use case is not configured` with the variable name it looked for. Add that variable to `.env`.
- **A different model than expected:** a variable in the service's process environment wins over `.env`. Check the service definition.
