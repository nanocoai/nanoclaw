---
name: add-ollama-provider
description: Point one NanoClaw agent group at a local Ollama model instead of the Anthropic API. Ollama serves the Anthropic API natively (/v1/messages), so the group needs an endpoint and a model — both `ncl groups config` fields, no source changes. Use when the user wants an agent running on their own hardware, zero token cost, or open-weight models. See docs/ollama.md for the tradeoffs.
---

# Add Ollama Provider

Routes **one** agent group's inference to a local [Ollama](https://ollama.com) daemon. Ollama exposes an Anthropic-compatible `/v1/messages`, so the provider code is unchanged: the group gets a `base_url` and a `model`, both fields of its container config.

Two `ncl` commands and a restart. No files are edited, nothing is rebuilt, and the host service keeps running.

Background, tradeoffs, model picks, and the prompt-cache speedup: [docs/ollama.md](../../../docs/ollama.md).

## Pick the route that matches the ask

Ask the user which of these they want before configuring anything — three of the four are not this skill:

| What the user wants | Route | Source changes |
|---|---|---|
| **One** agent group on a local model | this skill: `ncl groups config update --base-url --model` | none |
| **Every** claude group on one Anthropic-compatible endpoint (a self-hosted gateway, a proxy) | `ANTHROPIC_BASE_URL` in `.env` + the `src/providers/claude.ts` registration, which `/setup` wires | none |
| A different agent framework entirely (OpenRouter, DeepSeek, ChatGPT subscription) | `/add-opencode` or `/add-codex` | skill-installed provider |
| Claude still planning, a local model available as a tool it can call | `/add-ollama-tool` or `/add-atomic-chat-tool` | skill-installed MCP server |

## Prerequisites

1. **Ollama is running on the host** — `curl -s http://localhost:11434/api/tags` returns JSON.
2. **A tool-capable model is pulled** — `ollama list`. The agent leans on tool calls (read/write files, shell, send_message); a model that fumbles structured tool use will look broken rather than slow. Larger instruct/coder models handle it; 3B-class models generally do not.
3. **The agent group exists** — `ncl groups list`. Run `/init-first-agent` first if there is none.
4. **Egress lockdown is off** — see the next section. This is the one prerequisite that silently defeats everything downstream.

## 1. Check egress lockdown

```bash
grep -E '^NANOCLAW_EGRESS_LOCKDOWN=' .env
```

Empty or `false`: continue.

`true`: **stop and tell the user.** Under lockdown, containers join an `--internal` Docker network with no route off-box, and `host.docker.internal` is re-aliased to the OneCLI gateway container — so it resolves, but to the gateway, never to the host's Ollama. No env var works around that; it is the posture working as designed (`src/egress-lockdown.ts`). The options to offer:

- Run Ollama **as a container on the egress network** (`docker network connect nanoclaw-egress <ollama-container>`) and use its container name as the host in step 3.
- Turn lockdown off for this install (`NANOCLAW_EGRESS_LOCKDOWN=false` in `.env`, restart the service) if the user accepts open egress for their agents.

## 2. Ask the user (plain text, not AskUserQuestion)

1. **Which agent group?**

   ```bash
   ncl groups list
   ```

2. **Which Ollama model?** Use the exact name from the host:

   ```bash
   curl -s http://localhost:11434/api/tags | grep '"name"'
   ```

Record the group id as `GROUP_ID` and the model as `MODEL`.

## 3. Point the group at Ollama

```bash
ncl groups config update --id <GROUP_ID> \
  --base-url http://host.docker.internal:11434 \
  --model <MODEL>
```

`host.docker.internal` — not `localhost` — is how a container reaches a service on the host; on Linux the runtime maps it for every session. Keep the port as Ollama's (`11434`) unless the user runs it elsewhere.

What that one command sets up at the group's next spawn:

- `ANTHROPIC_BASE_URL` pointing at Ollama, so the Anthropic SDK inside the container calls it instead of `api.anthropic.com`.
- A placeholder bearer token, because the SDK sends an `Authorization` header or nothing at all. Ollama ignores it. **No real credential is involved**, here or anywhere: credentials live in the OneCLI vault and never enter a container.
- `NO_PROXY`/`no_proxy` for that host, so the request goes straight to Ollama rather than through the credential-injecting gateway proxy — merged into whatever the gateway already exempts, not replacing it.
- The model name, read by the provider inside the container.

Two things worth telling the user:

- This is **operator-only**. The same command from inside a container is refused, at any `cli_scope`, approval or not: the endpoint receives every prompt the group assembles, so it is not the agent's to move.
- Only plain-HTTP-to-this-machine and HTTPS-to-anywhere are accepted. `http://ollama.mybox.lan:11434` is rejected — put a TLS terminator in front, or tunnel it to a local port.

## 4. Restart the group

```bash
ncl groups restart --id <GROUP_ID>
```

Container config takes effect at spawn, so the group's running containers have to go. The host service itself is untouched — no source changed and no image needs rebuilding.

## 5. Tell the model what it is

Open-weight models trained on public conversations often introduce themselves as Claude. Add a line to the group's **standing instructions**, `groups/<folder>/instructions.prepend.md` — creating the file if it does not exist:

```markdown
You run on the local model `<MODEL>` served by Ollama, not on Claude. Say so if asked.
```

Write it there, not in `groups/<folder>/CLAUDE.md`: that file is composed from the shared base plus these standing instructions at every spawn, so an edit to it is erased the next time the group wakes.

## 6. Verify

Send the agent a message on its channel, then:

```bash
# Ollama has the model loaded and busy
curl -s http://localhost:11434/api/ps | grep '"name"'

# The container is actually pointed at Ollama
CTR=$(docker ps --filter "label=nanoclaw-group-folder=<FOLDER>" --format "{{.Names}}" | head -1)
docker exec "$CTR" env | grep -E 'ANTHROPIC_BASE_URL|NO_PROXY'
```

Expect `ANTHROPIC_BASE_URL=http://host.docker.internal:11434` and the same host in `NO_PROXY`.

To prove the wiring **before** installing Ollama — or to tell "Ollama is broken" apart from "the routing is broken" — run the endpoint harness, which stands a fake Anthropic-shape endpoint up on a local port, routes a real message through a real container, and reports whether the canned reply came back:

```bash
pnpm exec tsx scripts/test-v2-endpoint-e2e.ts
```

## Reverting

[REMOVE.md](REMOVE.md).

## Why this skill ships no test

Its entire footprint is two container-config fields written through `ncl` — no
file is added, no import is wired, so there is no line in the tree whose
deletion a test could catch. The mechanism those fields drive is guarded in
trunk, and `pnpm test` runs all of it:

| Guard | What breaks it |
|---|---|
| `src/providers/endpoint-env.test.ts` | endpoint → provider env, the local-only proxy bypass, the `NO_PROXY` merge |
| `src/container-runner.test.ts` | the contributed env lane, and a per-group endpoint beating the install-global and gateway ones |
| `src/container-config.test.ts` | the URL rule, and the read-back that drops a hand-edited value |
| `src/cli/crud.test.ts` | `--base-url` write, clear, and refusal for unsupported providers |
| `src/cli/dispatch.test.ts` | the operator-only denial for container callers |

## Troubleshooting

**First reply takes 10-30s, then nothing is fast.** Cold model load, then no prompt caching. Watch `curl -s http://localhost:11434/api/ps` for the load. For the caching part, the Claude Agent SDK puts a per-request nonce at the front of every prompt, which defeats Ollama's prefix cache; [docs/ollama.md](../../../docs/ollama.md) has a ~40-line proxy that pins it and the base URL to point at instead.

**"model not found".** The name in the config is not what Ollama has. Compare `ollama list` with `ncl groups config get --id <GROUP_ID>` and re-run step 3 with the exact string, tag included.

**The agent answers, but `api/ps` shows no activity.** It is still reaching Anthropic — the config did not land or the container predates it. Check `ncl groups config get --id <GROUP_ID>` shows your `base_url`, then re-run step 4; only a fresh container picks up config.

**Every reply is an auth or connection error.** `docker exec <CTR> curl -s http://host.docker.internal:11434/api/tags` from inside the container: empty means the container cannot see the host — re-check step 1 (lockdown), and that Ollama is bound to all interfaces (`OLLAMA_HOST=0.0.0.0`) rather than loopback only.

**Tool calls loop, stall, or come back malformed.** A model limitation, not a wiring one. Try a larger tool-capable model, or keep this group for chat work and leave tool-heavy groups on Claude — the setting is per group precisely so both can coexist.

**Responses claim to be Claude.** Step 5.
