# Running an Agent on Local Ollama

One NanoClaw agent group can run its inference on a local [Ollama](https://ollama.com) daemon instead of the Anthropic API: zero token cost, nothing leaving the machine, open-weight models. It is a per-group setting, so a local group and a Claude group coexist in the same install.

`/add-ollama-provider` is the step-by-step. This document is the why, the tradeoffs, and the two performance notes that decide whether the result feels usable.

## How it works

Ollama serves an Anthropic-compatible `/v1/messages`. The Claude Agent SDK inside the agent container reads `ANTHROPIC_BASE_URL` to decide where to call. Pointing that at Ollama is the entire mechanism — no provider code, no changes to the agent runtime.

```
┌──────────────────────────────┐
│  Agent container             │
│                              │
│  Claude Agent SDK            │
│    ↓ ANTHROPIC_BASE_URL      │
│    http://host.docker.       │      ┌──────────────────────┐
│    internal:11434     ───────┼─────▶│  Ollama :11434       │
│                              │      │  <your model>        │
└──────────────────────────────┘      └──────────────────────┘
```

`host.docker.internal` is how a container addresses the host; the runtime maps it for every session. A container's own `localhost` is the container.

## Where the setting lives

`container_configs.base_url`, one row per agent group in the central DB, set with:

```bash
ncl groups config update --id <group-id> --base-url http://host.docker.internal:11434 --model <model>
ncl groups restart --id <group-id>
```

At the group's next spawn the host turns that into container env (`endpointEnvFor`, `src/providers/endpoint-env.ts`):

| Variable | Value | Why |
|---|---|---|
| `ANTHROPIC_BASE_URL` | the endpoint | where the SDK calls |
| `ANTHROPIC_AUTH_TOKEN` | `placeholder` | the SDK sends an `Authorization` header or nothing; Ollama ignores the value |
| `NO_PROXY` / `no_proxy` | the endpoint's host | send the request straight to Ollama instead of through the credential-injecting gateway proxy |

The proxy bypass is added **only for a loopback / `host.docker.internal` endpoint**. A remote HTTPS endpoint deliberately keeps the proxy in the path, because that is how OneCLI attaches its real credential without the credential ever entering the container. And it is *merged* into whatever the gateway already exempts, never substituted for it.

Three rules worth knowing before you set it:

- **HTTPS off-box.** Plain HTTP is accepted only for `localhost`, `127.0.0.1`, `[::1]` and `host.docker.internal`. `http://ollama.mybox.lan` is refused; terminate TLS or tunnel it to a local port.
- **Operator-only.** An agent cannot set it from inside its container, at any `cli_scope`, with or without approval. The endpoint receives every prompt the group assembles — memory, instructions, whatever a tool just read — so moving it is an exfiltration primitive, and an approval card reading `--base-url https://…` is exactly the kind a human waves through.
- **`groups/<folder>/container.json` is generated output.** It is rewritten from the DB at every spawn; editing it changes nothing. The DB, via `ncl`, is the only input.

Other providers (`opencode`, `codex`) configure their endpoints through their own surfaces, so `--base-url` is refused for a group running one of them rather than stored where nothing reads it.

## The three routes, and which one you want

| Goal | Route |
|---|---|
| One group local | `--base-url` per group (this document) |
| Every claude group on one Anthropic-compatible endpoint | `ANTHROPIC_BASE_URL` in `.env` + the `src/providers/claude.ts` registration that `/setup` wires |
| A different agent framework (OpenRouter, DeepSeek, a ChatGPT subscription) | `/add-opencode`, `/add-codex` |
| Claude still planning, a local model as a callable tool | `/add-ollama-tool`, `/add-atomic-chat-tool` |

## Egress lockdown makes this impossible

With `NANOCLAW_EGRESS_LOCKDOWN=true`, containers join an `--internal` Docker network with no route off-box, and `host.docker.internal` is re-aliased to the OneCLI gateway container (`src/egress-lockdown.ts`). It resolves — to the gateway, never to the host's Ollama — and no env var changes that. Either run Ollama as a container attached to the `nanoclaw-egress` network and point `base_url` at its container name, or turn lockdown off for the install.

## Model selection

Use the exact name from `ollama list`, tag included. The agent is tool-heavy: it reads and writes files, runs shell commands, and calls `send_message` to reply at all. A model that handles structured tool calls unreliably does not look slow, it looks broken — so pick a large instruct or coder model rather than the smallest one that fits. Anything in the 3B class is for experiments, not for an agent doing work.

Rough hardware framing: a quantized ~30B model wants ~24GB of unified memory or VRAM to be comfortable; a ~12B model runs on 16GB.

## Speed: cold start, and the prompt-cache trap

**Cold start.** The first request loads the model — 5-30s depending on size. `curl -s http://localhost:11434/api/ps` shows it once resident.

**Every turn re-reading the whole prompt.** Out of the box this path is slow in a way that looks like the model being slow: each reply re-processes the entire multi-thousand-token system prompt, even for a one-word answer.

The cause is one value, not the model. The Claude Agent SDK prefixes every request with a per-request hash (`x-anthropic-billing-header: …; cch=<hash>;`). Ollama's prefix cache only reuses a prompt whose beginning is unchanged, so a value that changes every turn makes every prompt new. Ollama ignores the hash itself, so pinning it changes nothing about the output.

The fix is a ~40-line proxy between the container and Ollama that pins the hash to a constant, with `base_url` pointing at the proxy instead of Ollama:

```bash
ncl groups config update --id <group-id> --base-url http://host.docker.internal:11999
```

```js
// ollama-cch-proxy.mjs — pin the SDK's per-request cch nonce so Ollama's prefix
// cache survives across turns. Listens on :11999, forwards to Ollama.
import http from 'node:http';

const TARGET_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const TARGET_PORT = Number(process.env.OLLAMA_PORT || 11434);
const LISTEN_PORT = Number(process.env.PROXY_PORT || 11999);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    if (req.method === 'POST' && body.length) {
      body = Buffer.from(body.toString('utf8').replace(/cch=[0-9a-f]+;/g, 'cch=00000;'), 'utf8');
    }
    const headers = { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}`, 'content-length': String(body.length) };
    const proxyReq = http.request(
      { host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on('error', (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    proxyReq.end(body);
  });
});
server.listen(LISTEN_PORT, '0.0.0.0', () => console.log(`cch-proxy :${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`));
```

On one 31B-on-Apple-Silicon setup this took follow-up replies from ~80s to ~4s; the numbers move with model size and hardware. Run it durably — a systemd user unit on Linux (`systemctl --user enable --now`, plus `loginctl enable-linger "$USER"` so it survives logout), a launchd user agent on macOS.

Scope: this only affects the Claude-Agent-SDK path. Codex and OpenCode never emit the hash and get prefix caching for free.

## Verifying without Ollama

`scripts/test-v2-endpoint-e2e.ts` stands up a fake Anthropic-shape endpoint on a local port, routes a real message through a real container with `base_url` pointed at it, and reports whether the canned reply came back through delivery:

```bash
pnpm exec tsx scripts/test-v2-endpoint-e2e.ts
```

A PASS means the routing, the env, the spawn and the delivery path all work, which separates "Ollama or the model is the problem" from "the wiring is the problem". The stub it drives (`scripts/anthropic-endpoint-stub.mjs`) also runs standalone if you want to point a group at a canned endpoint by hand.

## Tradeoffs

| | Ollama (local) | Anthropic API |
|---|---|---|
| Cost | free | pay-per-token |
| Privacy | stays on the machine | sent to Anthropic |
| Model quality | good (open-weight) | excellent |
| Cold start | 5-30s (model load) | ~1s |
| Context window | model-dependent, usually far smaller | large |
| Tool-use reliability | good on large models, poor on small | excellent |
| Hardware | 16GB+, more for larger models | none |

For personal automation on capable hardware the tradeoff often favors local. For long multi-step work, large context, or anything where a fumbled tool call costs real time, Claude is still ahead. Keep both: the setting is per group.

## See also

- `/add-ollama-provider` — configure a group for Ollama
- `/add-ollama-tool` — Ollama as a callable MCP tool, with Claude still planning
- [db-central.md](db-central.md#115-container_configs) — the `container_configs` table, including `base_url`
- [Ollama's API compatibility docs](https://docs.ollama.com/api)
