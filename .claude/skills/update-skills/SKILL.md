---
name: update-skills
description: Refresh installed NanoClaw channel and provider payloads from their registry branches with fork-safe remote resolution and a blocking structured result. Use after updating NanoClaw or whenever installed channel/provider code may be stale.
---

# Update installed skills

Refresh the code carried by installed channel and provider skills. This does
not re-run credential setup, change `.env`, alter wiring, or restart services.

Run from the NanoClaw project root. Use ordinary conversation for any choice;
do not depend on a provider-specific question or skill-invocation tool.

## 1. Preflight and selection

Require a clean working tree:

```bash
git status --porcelain
```

If it is dirty, stop. Never mix a refresh with unrelated changes.

The default is every installed channel/provider. If the user asked for a
subset, pass its comma-separated names. Otherwise use `all`:

```bash
pnpm exec tsx scripts/update-skills.ts --skills all
# Example subset: --skills slack,opencode
```

The helper detects installed skills from the real channel/provider barrels. It
resolves each registry branch by checking configured remotes, so a fork whose
`origin` is the user's repo and whose official source is `upstream` works
without special handling. `NANOCLAW_REGISTRY_REMOTE=<name>` is an explicit
override and is validated before use.

## 2. Treat the JSON result as a gate

The command prints `nanoclaw-skill-refresh/v1`-shaped JSON fields with one
result per selected skill and exits nonzero unless every selected skill was
fully refreshed.

- Continue only when `success` is `true` and every status is `refreshed`.
- A missing skill, missing structured apply contract, unresolved input, agent
  fallback, fetch error, or dependency error is blocking.
- Never record a failed skill and continue toward an upgrade completion stamp.
- Preserve the full report in the update summary.

The refresh engine overwrites skill-owned registry files and advances exact
dependency/CLI-manifest pins. It skips prompts, operator walkthroughs, `.env`
writes, wiring, restarts, and ordinary build/test directives.

## 3. Validate the composed checkout

After a successful refresh:

```bash
pnpm run build
pnpm test
```

If files under `container/agent-runner/src/` changed, also run:

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

If anything under `container/` changed, update the install's agent image using
the source mode already selected in `.env`:

```bash
if grep -q '^NANOCLAW_HARDENED_IMAGE=true$' .env 2>/dev/null; then
  ./container/build.sh pull
else
  ./container/build.sh
fi
```

Any validation or image failure is blocking. Do not restart or report success.

## 4. Report

Show the selected skills, the registry remote used for each branch, changed
files, validation results, and any blocking error. If this was a standalone
refresh and the service was running, restart it through the service mode that
actually owns this install and verify `data/ncl.sock` plus `bin/ncl groups
list`. When called inside `/update-nanoclaw`, leave restart and health checking
to that transaction.
