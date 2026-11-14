# Remove Model Use Cases

Every step is idempotent.

## 1. Move groups off use-case tokens

`container.json` holds the resolved model, so find the tokens in the stored config:

```bash
ncl groups list
ncl groups config get --id <group-id>   # for each group: look for a "usecase:" model
```

For each group with a token, set the concrete model its use case maps to in `.env`:

```bash
ncl groups config update --id <group-id> --model <model>
```

Do this first: once the resolver is gone, a stored token reaches the provider as a literal model name.

If `NANOCLAW_DEFAULT_MODEL` is a `usecase:` token, replace it with a concrete model.

## 2. Unwire `src/container-config.ts`

Delete the import line:

```ts
import { resolveModelUseCase } from './model-use-cases.js';
```

Unwrap the `model:` line in `configFromDb` back to:

```ts
    model: row.model ?? (DEFAULT_MODEL || undefined),
```

## 3. Delete the copied files

```bash
rm -f src/model-use-cases.ts src/model-use-cases.test.ts
```

## 4. Remove the variables

Delete every `NANOCLAW_USE_CASE_MODEL_*` line from `.env`.

## 5. Rebuild and restart

```bash
pnpm run build
```

Restart the service, then restart each group changed in step 1:

```bash
ncl groups restart --id <group-id>
```
