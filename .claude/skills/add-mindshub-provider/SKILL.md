---
name: add-mindshub-provider
description: Route NanoClaw's Claude Code agents through MindsHub (https://mindshub.ai), a hosted Anthropic-compatible gateway that serves Claude, Kimi, DeepSeek, GPT, Gemini and other catalog models behind one API key. Uses NanoClaw's existing custom-Anthropic-endpoint provider (src/providers/claude.ts) plus a OneCLI vault secret — no provider code changes needed. Use when the user wants model choice beyond Claude, or consolidated billing across models, without running local inference. See docs/mindshub.md for background and the OneCLI-proxy rationale.
---

# Add MindsHub Provider

Points the `claude` provider's Anthropic client at MindsHub instead of
`api.anthropic.com`, using NanoClaw's already-existing custom-endpoint seam
(`src/providers/claude.ts`) and a OneCLI vault secret so the real MindsHub key
never enters the agent container.

See `docs/mindshub.md` for how this works, and specifically why this setup
routes *through* the OneCLI credential proxy rather than bypassing it (the
opposite of `/add-ollama-provider`, which is for a local, unauthenticated
endpoint).

## Prerequisites

1. **A MindsHub account and API key** from the [MindsHub console](https://console.mindshub.ai) — starts with `mdb_`.
2. **OneCLI is installed and running** on the host — verify: `onecli version`
3. **The agent group already exists** — run `/init-first-agent` first if needed.

## 1. Check current setup

```bash
grep -n "ANTHROPIC_BASE_URL" .env 2>/dev/null
grep -n "import './claude.js'" src/providers/index.ts
onecli secrets list 2>/dev/null | grep -i mindshub
```

If `ANTHROPIC_BASE_URL` is already set to something other than MindsHub (e.g.
Ollama, or another custom endpoint), tell the user this is an **install-wide**
setting — pointing it at MindsHub will affect every agent group using the
`claude` provider, not just one. Confirm before overwriting.

If a MindsHub secret already exists in the vault, skip step 2 and go to step 3.

## 2. Register the MindsHub key in OneCLI's vault

Ask the user for their MindsHub API key (never write it to `.env` or any file
NanoClaw controls — it goes into OneCLI's vault only):

```bash
onecli secrets create \
  --name MindsHub \
  --type generic \
  --value "$MINDSHUB_API_KEY" \
  --host-pattern api.mindshub.ai \
  --header-name Authorization \
  --value-format 'Bearer {value}'
```

This is the same shape NanoClaw's own setup wizard uses for any custom
Anthropic-compatible endpoint (`setup/auto.ts`'s `runCustomEndpointAuth`) — a
generic secret, scoped by host-pattern, with the header NanoClaw's OneCLI
gateway should inject on outbound requests to that host. The container never
holds this value.

## 3. Point the claude provider at MindsHub

Add (or update) `ANTHROPIC_BASE_URL` in the project's `.env` — host only, no
`/v1` suffix (Claude Code appends `/v1/messages` itself):

```bash
grep -q '^ANTHROPIC_BASE_URL=' .env 2>/dev/null \
  && sed -i.bak 's|^ANTHROPIC_BASE_URL=.*|ANTHROPIC_BASE_URL=https://api.mindshub.ai|' .env \
  || echo 'ANTHROPIC_BASE_URL=https://api.mindshub.ai' >> .env
rm -f .env.bak
```

Register the `claude` provider's host-side container contribution by
appending the import line to the barrel (idempotent — skip if already
present):

```bash
grep -qxF "import './claude.js';" src/providers/index.ts \
  || echo "import './claude.js';" >> src/providers/index.ts
```

**Why these two files and nothing else:** `src/providers/claude.ts` already
exists in NanoClaw's source and is self-registering — it reads
`ANTHROPIC_BASE_URL` from `.env` and, when present, contributes
`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN=placeholder` into every agent
container's env. `ANTHROPIC_AUTH_TOKEN` (not `ANTHROPIC_API_KEY`) is required —
MindsHub only accepts `Authorization: Bearer …`, and `ANTHROPIC_API_KEY` would
send `x-api-key` and get a 401 before the request reaches the model. This
provider file is not loaded by default (standard installs hitting real
Anthropic don't need it); the barrel import is what activates it.

## 4. Set the model

MindsHub addresses models by catalog alias (`sonnet`, `kimi`, `deepseek`,
`gpt-codex`, …), not raw provider model IDs. List the current catalog:

```bash
curl -s https://api.mindshub.ai/v1/models -H "Authorization: Bearer $MINDSHUB_API_KEY" | \
  python3 -c 'import json,sys; [print(m["id"], "-", m.get("label","")) for m in json.load(sys.stdin)["data"]]'
```

Find the agent group and set its model:

```bash
ncl groups list
ncl groups config update --id <group-id> --provider claude --model sonnet
```

Claude Code's own model names also work unmodified (`claude-sonnet-5`,
`claude-opus-5[1m]`, …) — MindsHub maps them onto the matching alias by family,
so `/model` inside the container keeps working without any NanoClaw-side
translation. Prefer a catalog alias if you want a *non*-Claude model (`kimi`,
`deepseek`, `gpt-codex`, etc.).

`ncl groups config update` writes to the DB but does not take effect until
restart:

```bash
ncl groups restart --id <group-id>
```

## 5. Build and restart

Only needed if `src/providers/index.ts` changed (step 3) — the barrel is
compiled host code, not something a container respawn alone picks up:

```bash
pnpm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# Linux: systemctl --user restart nanoclaw
```

If you only changed the model (step 4) on an install that already has
MindsHub wired up, `ncl groups restart --id <group-id>` is enough.

## 6. Verify

Send a message to the agent, then confirm the container has the placeholder
token (never the real key) and that OneCLI is injecting the real credential
on the wire:

```bash
CTR=$(docker ps --filter "label=nanoclaw-group-folder=<FOLDER>" --format "{{.Names}}" | head -1)
docker exec "$CTR" env | grep ANTHROPIC
# Expect: ANTHROPIC_BASE_URL=https://api.mindshub.ai
#         ANTHROPIC_AUTH_TOKEN=placeholder
```

A successful reply confirms OneCLI rewrote the Bearer token correctly — the
container itself only ever has the placeholder.

## Reverting to Claude direct

1. Remove `ANTHROPIC_BASE_URL` from `.env` (leaving the `claude.js` import in
   place is harmless — the provider no-ops without the env var, but removing
   it is tidier).
2. Reset any `--model` overrides that are MindsHub-only aliases:
   `ncl groups config update --id <group-id> --model ""` (clears back to the
   provider default).
3. `pnpm run build` and restart the service.

The MindsHub secret can stay in OneCLI's vault — it's inert without a request
actually addressed to `api.mindshub.ai`.

## Troubleshooting

**`401` from MindsHub in container logs:** confirm `ANTHROPIC_AUTH_TOKEN` (not
`ANTHROPIC_API_KEY`) is what's set — check with the `docker exec ... env`
command in step 6. If it's right there but still failing, the OneCLI secret's
`--host-pattern` probably doesn't match `api.mindshub.ai` exactly, or the key
itself is wrong/revoked — re-run `onecli secrets list` and check.

**"There's an issue with the selected model":** the model string isn't a
MindsHub catalog alias or a recognizable Claude family name, or
`ANTHROPIC_BASE_URL` has a trailing `/v1` (it shouldn't — Claude Code appends
that itself).

**Agent still calls real Anthropic / bills unexpectedly:** `ANTHROPIC_BASE_URL`
isn't actually taking effect in the container — confirm `src/providers/index.ts`
carries the `claude.js` import and that `pnpm run build` ran afterward. Provider
env registration is host-compiled code; a barrel edit without a rebuild is a
no-op.

**Replies truncate mid-answer:** some MindsHub-served models reason
internally even without an adjustable effort level, consuming part of the
output budget. Raise `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (e.g. to `8192`) via the
group's env, if this becomes a problem.

**Switching back and forth between MindsHub and a local Ollama:** don't set
both `ANTHROPIC_BASE_URL` targets at once. Only one `ANTHROPIC_BASE_URL` is
active install-wide — see `docs/mindshub.md`'s scope note.
