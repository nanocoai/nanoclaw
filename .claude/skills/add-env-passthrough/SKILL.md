---
name: add-env-passthrough
description: Forward operator-listed, non-secret host environment variables from .env into agent containers. Use when a container needs a plain setting (a timeout, a log format, a feature flag) that the host already has, without editing core or baking it into the image.
---

# Add env passthrough

List variable names in `.env` and NanoClaw passes their values into every agent container at spawn. The module registers one contributor with the container env seam (`registerEnvContributor` in `src/container-env-contributors.ts`); nothing in core changes.

## What this sets up

- `src/modules/env-passthrough/` with the contributor, its selection logic, and a wiring test
- one import line in `src/modules/index.ts`

## How it behaves

- The list lives in `.env` as `CONTAINER_ENV_PASSTHROUGH`, comma- or space-separated. Each listed name's value is read from `.env` too.
- `.env` is read on every spawn, so a change reaches the next container without a host restart. Running containers keep the env they started with.
- With `CONTAINER_ENV_PASSTHROUGH` unset, the contributor returns nothing and a spawn is unchanged.
- **Credentials are never forwarded.** A listed pair is skipped, with a warning in the host log, when its name ends in `_KEY`, `_TOKEN`, `_SECRET` or `PASSWORD`, or its value looks like a credential. Credentials stay with the credential gateway.
- Names that NanoClaw, the gateway or the runtime own are refused: `NANOCLAW_*`, `ANTHROPIC_*`, `CLAUDE_*`, `LD_*`, `DYLD_*`, `PATH`, `HOME`, `USER`, `SHELL`, `PWD`, `TZ`, `NODE_OPTIONS` and the proxy variables.
- On a collision the gateway's contributed env still wins; this module's values win over the model provider's.

## Integration tests

`src/modules/env-passthrough/index.test.ts` drives the real seam: it imports the module, then reads the merged env through `collectContributedEnv`. It goes red if the registration is deleted or drifts, and it asserts the barrel line is present. Unit checks of the selection logic ship in the skill's own `scripts/env-passthrough.test.ts` and run with the repo's normal test suite.

## Apply

1. Copy the payload into place (overwrite; re-running is safe):

   ```bash
   mkdir -p src/modules/env-passthrough
   cp .claude/skills/add-env-passthrough/payload/src/modules/env-passthrough/* src/modules/env-passthrough/
   ```

2. Append this line to `src/modules/index.ts` if it is not already there:

   ```ts
   import './env-passthrough/index.js';
   ```

3. Name the variables to forward in `.env` (the operator adds the lines; a name needs a value line of its own):

   ```
   CONTAINER_ENV_PASSTHROUGH=LOG_FORMAT,HTTP_TIMEOUT_MS
   LOG_FORMAT=json
   HTTP_TIMEOUT_MS=30000
   ```

4. Build, test, restart:

   ```bash
   pnpm run build
   pnpm exec vitest run src/modules/env-passthrough
   bash setup/lib/restart.sh
   ```

## Verify

Start a session, then check the container env:

```bash
docker exec "$(docker ps --format '{{.Names}}' | head -1)" printenv LOG_FORMAT
```

## Troubleshooting

### A listed variable is missing in the container

Look for `env-passthrough: variable not forwarded` in `logs/nanoclaw.log`. The `reason` is `unset` (no value in `.env`), `invalid-name`, `reserved-name`, or `secret-shaped`. Restart the container (`ncl groups restart --id <group-id>`) so the next spawn re-reads `.env`.

### The host refuses a spawn with `credential value in contributed env`

A value matched a credential pattern the module's check did not. Remove that name from `CONTAINER_ENV_PASSTHROUGH`; keep credentials in the gateway.
