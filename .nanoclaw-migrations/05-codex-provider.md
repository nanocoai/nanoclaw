# 05 — Codex Provider: local deltas vs the providers branch

**Base install is redone via `/add-codex`.** Do NOT port the local codex files wholesale.

## History / why the local files differ so much from origin/providers

Local commit `3c8397e2` ("install codex provider from providers branch (1e7cb8b)")
deliberately installed an **older** providers-branch payload — the last one compatible with
the then-current trunk registry (the newer payload needed `providesAgentSurfaces`/`groupDir`
registry fields that trunk lacked at the time). On a clean checkout of today's
`origin/main`, those registry fields exist and `origin/providers` HEAD (`f2b75837`) now
carries the **payload-v2** codex provider including the #3013 memory-session-hook changes.
So a plain `/add-codex` on the new base gives you a strictly newer implementation.

Local files affected: `src/providers/codex.ts`, `src/providers/index.ts` (+`import './codex.js';`),
`container/agent-runner/src/providers/codex.ts`, `codex-app-server.ts`, `codex.factory.test.ts`,
`container/agent-runner/src/providers/index.ts` (+`import './codex.js';`), Dockerfile Codex
block. All installed/wired by the skill — stock.

## Local deltas and their status

### (a) Reasoning-effort passthrough (local commit 84ea6294) — **SUPERSEDED upstream**

Locally, `container_configs.effort` was threaded into
`createCodexConfigOverrides(baseUrl, reasoningEffort)` → `model_reasoning_effort="…"` and a
`private readonly effort` on `CodexProvider`. The current origin/providers payload already
has first-class effort support (`normalizeEffort`, `effort` in `writeCodexConfigToml`
options, `model_reasoning_effort` emission). **Nothing to reapply** — just verify after
install: `ncl groups config update --id <g> --effort high` + restart actually changes Codex
reasoning (grep the generated `~/.codex/config.toml` in the session dir for
`model_reasoning_effort`).

### (b) CLAUDE.local.md / memory loading into Codex baseInstructions — **LIKELY SUPERSEDED**

Local codex.ts loads `/workspace/agent/CLAUDE.md` (or `AGENT.md`) **plus
`/workspace/agent/CLAUDE.local.md`** into `baseInstructions`, because Codex doesn't read
cwd memory files the way Claude Code does (without this, a Claude→Codex fallback "forgot"
everything about the user — observed live 2026-07-08). The new upstream payload addresses
the same problem via the **memory session hook** (#3013) + `systemContext.instructions`
plumbing from the poll-loop, and upstream group personas now live in
`instructions.prepend.md` rather than `CLAUDE.local.md`.

**Action:** after `/add-codex`, verify a Codex turn actually receives the group's standing
instructions + memory (send a test message to a codex-provider group and ask it what it
knows about the user). Only if the upstream hook does NOT cover per-group memory, re-add a
local loader in the container codex provider modeled on this (adapted to read
`instructions.prepend.md` and whatever memory file upstream mounts at `/workspace/agent`):

```ts
// Codex's app-server doesn't read CLAUDE.md/AGENT.md from cwd the way Claude
// Code does. We have to load it and pass it in as `baseInstructions`.
function loadAgentBaseInstructions(): string | undefined {
  const candidates = ['/workspace/agent/CLAUDE.md', '/workspace/agent/AGENT.md'];
  const parts: string[] = [];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      parts.push(fs.readFileSync(p, 'utf-8'));
      break;
    }
  }
  // Per-group memory (user preferences, project context). Without loading it
  // explicitly the fallback engine loses everything the agent "knows" about
  // the user — a big part of why a Claude→Codex switch felt like talking to a
  // different person (reported live 2026-07-08).
  const localMd = '/workspace/agent/CLAUDE.local.md';
  if (fs.existsSync(localMd)) {
    parts.push(fs.readFileSync(localMd, 'utf-8'));
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}
```

### (c) Quota/fallback hooks in the codex provider — **covered by the quota-fallback guide**

The following local codex behaviors belong to the quota-fallback feature and are documented
in the quota-fallback migration sections (do not duplicate; listed here so nothing is lost):

- Idle-based turn timeout: `TURN_TIMEOUT_MS = Number(process.env.CODEX_TURN_TIMEOUT_MS) || 120_000`,
  armed as an **idle** ceiling re-set on every app-server notification (a fixed wall-clock
  ceiling killed heavy fallback turns — live 2026-07-07).
- `STALE_THREAD_RE = /thread\s+not\s+found|unknown\s+thread|thread[_\s]id|no such thread/i`
  → `isSessionInvalid()` so a poisoned/stale Codex thread triggers a fresh-thread retry.
- Abort hoisting: live app-server handle stored so `abort()` can kill the process while a
  JSON-RPC request is awaited.
- Native compaction trigger at `COMPACT_THRESHOLD = 40_000` cumulative input tokens.
- `codex.factory.test.ts` local version tests `createProvider('codex')`, stale-thread
  classification, and `supportsNativeSlashCommands === false` (replaces the upstream
  effort-normalization tests).

When reapplying the quota-fallback guide, these must be re-implemented **against the new
upstream codex payload**, which is structurally different (runtime object, memory hook) —
expect adaptation, not clean patch application.

### (d) Host-side `src/providers/codex.ts` — stock

The local 49-line host contribution (per-session `~/.codex` dir, auth.json copy,
`OPENAI_API_KEY`/`CODEX_MODEL`/`OPENAI_BASE_URL` passthrough) came from the providers
branch. Upstream now has its own `src/providers/codex.ts` (+ `codex-agents-md.ts`,
host-contribution tests). Use the skill-installed version.

## Dockerfile

The `/add-codex` skill itself adds (idempotent):

```dockerfile
ARG CODEX_VERSION=0.124.0
```
and, as its own layer after the claude-code block:
```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@openai/codex@${CODEX_VERSION}"
```

This matches the local Dockerfile exactly — nothing extra to do beyond running the skill.
(Other local Dockerfile deltas are covered in 06-skills-and-misc.md.)

## Post-install configuration (installation state, run once)

- Codex groups need `agent_provider`/provider config restored:
  `ncl groups config update --id <group> --provider codex` (+ restart). Known gotcha from
  live ops: per-group `image_tag` must be cleared/rebuilt (`--rebuild`) when switching a
  group to codex; provider changes need `ncl groups restart`.
- Host `~/.codex/auth.json` (ChatGPT subscription login via `codex login`) is machine
  state, not in git — it survives the checkout switch untouched.
- `bun.lock` / `package.json` in `container/agent-runner` will be regenerated by the skill;
  the local tree also bumped `@anthropic-ai/claude-agent-sdk` to `0.3.197`, added
  `@anthropic-ai/sdk@0.106.0`, and `@modelcontextprotocol/sdk@^1.29.0` — check what
  upstream main pins before re-bumping (see 06-skills-and-misc.md, Dockerfile/CC section).
