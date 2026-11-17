# Remove the Antigravity agent provider

Reverses every change `/add-antigravity` makes and returns every group to the default provider. Safe to run when partially installed — skip any step whose target is already absent.

## 1. Switch antigravity groups back to the default

List groups still on antigravity and switch each one (each group's `memory/` tree stays on disk and readable; run `/migrate-memory` per group if its memory should carry back to Claude — see [docs/provider-migration.md](../../docs/provider-migration.md)):

```bash
ncl groups list
# for each group whose config shows provider=antigravity:
ncl groups config update --id <group-id> --provider claude
ncl groups restart --id <group-id>
```

If a group's config also sets an agy model slug (for example `gemini-3.8-flash-medium`) or an effort only agy accepts (`xhigh`, `max`), add `--model <model>` and `--effort <effort>` values the new provider accepts to that update; Claude cannot run a Gemini model name.

If `.env` has `DEFAULT_AGENT_PROVIDER=antigravity`, change that key to `claude` (or another installed provider) now, so groups created after the restart do not pick the removed provider.

## 2. Delete the barrel imports

Delete (do not comment out) the `import './antigravity.js';` line from each of:

- `src/providers/index.ts`
- `src/provider-contracts/index.ts`
- `container/agent-runner/src/providers/index.ts`
- `container/agent-runner/src/provider-contracts/index.ts`
- `setup/providers/index.ts`

## 3. Delete the Dockerfile block

Delete these five lines from `container/Dockerfile`. They sit inside core's `nanoclaw:provider-binaries` region, between its two marker lines. Leave every other line alone, including the `# >>> nanoclaw:provider-binaries` and `# <<< nanoclaw:provider-binaries` marker lines, which belong to core:

```dockerfile
# ---- Antigravity CLI (add-antigravity) ----
ARG AGY_VERSION=1.5.8
COPY install-antigravity.sh /tmp/install-antigravity.sh
RUN AGY_REQUESTED_VERSION="${AGY_VERSION}" sh /tmp/install-antigravity.sh && rm /tmp/install-antigravity.sh
ENV AGY_CLI_DISABLE_AUTO_UPDATE=true
```

## 4. Delete every copied file

```bash
rm -f src/providers/antigravity.ts \
      src/providers/antigravity-registration.test.ts \
      src/providers/antigravity-host-contribution.test.ts \
      src/provider-contracts/antigravity.ts \
      src/antigravity-dockerfile.test.ts \
      src/antigravity-installer.test.ts \
      container/install-antigravity.sh \
      container/agent-runner/src/providers/antigravity.ts \
      container/agent-runner/src/providers/antigravity-config.ts \
      container/agent-runner/src/providers/antigravity-protocol.ts \
      container/agent-runner/src/providers/antigravity-registration.test.ts \
      container/agent-runner/src/providers/antigravity.conformance.test.ts \
      container/agent-runner/src/providers/antigravity.factory.test.ts \
      container/agent-runner/src/providers/antigravity.turns.test.ts \
      container/agent-runner/src/providers/antigravity.poll-loop.test.ts \
      container/agent-runner/src/providers/antigravity-config.test.ts \
      container/agent-runner/src/providers/antigravity-protocol.test.ts \
      container/agent-runner/src/providers/antigravity.native.test.ts \
      container/agent-runner/src/providers/antigravity.gateway-proxy.test.ts \
      container/agent-runner/src/provider-contracts/antigravity.ts \
      setup/providers/antigravity.ts \
      setup/providers/antigravity.test.ts \
      setup/providers/antigravity-registration.test.ts
```

`antigravity.native.test.ts` and `antigravity.gateway-proxy.test.ts` are listed in case one was copied in by hand to run it; the install never copies them.

Leave `container/agent-runner/src/provider-contracts/exchange-archive.ts` in place: it is core's shared exchange archive, not a skill file.

This skill itself (`.claude/skills/add-antigravity/`) stays — it ships with trunk so the provider can be re-added later.

## 5. Gateway credential (optional)

The `Antigravity Gemini API` connection (`x-goog-api-key` for `generativelanguage.googleapis.com`) grants nothing once the provider is gone. It is user data: remove it through your gateway's own tools only if the operator asks. The key itself also lives on in Google AI Studio; delete or restrict it there (https://aistudio.google.com/apikey) if it should stop working everywhere.

## 6. Per-group state (optional)

Each antigravity group keeps its agy home (settings, MCP config, the `nanoclaw.md` rule file, self-authored skills, and the conversation database) under `data/v2-sessions/<group-id>/.gemini-shared/`. Delete it only if the group will never return to antigravity.

## 7. Rebuild and verify

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh build
pnpm test
cd container/agent-runner && bun test
```

The image rebuild drops `/usr/local/bin/agy`. All suites green and `ncl groups list` showing no antigravity groups means the removal is complete. Restart the service with `bash setup/lib/restart.sh`.
