# Running Agents on MindsHub

NanoClaw agents can be routed through [MindsHub](https://mindshub.ai), a hosted LLM
gateway that speaks the Anthropic Messages API and can serve Claude, Kimi,
DeepSeek, GPT, Gemini, and other catalog models behind one API key and one bill.
This is useful if you want model choice (including non-Claude models) without
juggling multiple vendor accounts, or want one consolidated invoice across every
agent and application on the key.

Unlike [Ollama](ollama.md), MindsHub is a real hosted service reachable over the
internet, not a local process — the setup differs in one important way: instead
of *bypassing* NanoClaw's credential proxy, you route through it.

## How It Works

MindsHub exposes an Anthropic-compatible `POST /v1/messages` endpoint at
`https://api.mindshub.ai`. The Claude Code CLI (running inside agent containers)
uses the Anthropic SDK, which reads `ANTHROPIC_BASE_URL` for the API host and
`ANTHROPIC_AUTH_TOKEN` for a Bearer-style credential — MindsHub specifically
requires `ANTHROPIC_AUTH_TOKEN` rather than `ANTHROPIC_API_KEY`, since the latter
sends `x-api-key`, which MindsHub rejects with a 401.

NanoClaw already has a provider registration for exactly this case:
`src/providers/claude.ts`. It activates whenever `ANTHROPIC_BASE_URL` is present
in the project's `.env`, and contributes two env vars into the agent container:

- `ANTHROPIC_BASE_URL` — the configured endpoint (here, `https://api.mindshub.ai`)
- `ANTHROPIC_AUTH_TOKEN=placeholder` — a stand-in the container never resolves
  itself

No provider code changes are needed. This is the same seam a from-scratch
custom-Anthropic-endpoint setup (`NANOCLAW_ANTHROPIC_BASE_URL` /
`NANOCLAW_ANTHROPIC_AUTH_TOKEN` during initial `bash nanoclaw.sh`) already wires
up — adding MindsHub means walking the same path by hand on an existing install.

```
┌───────────────────────────────┐
│  Agent container              │
│                                │
│  Claude Code CLI               │
│    ANTHROPIC_BASE_URL          │      ┌──────────────────┐
│    = https://api.mindshub.ai   │      │  OneCLI gateway  │
│    ANTHROPIC_AUTH_TOKEN        │      │  (host.docker.   │      ┌──────────────────┐
│    = placeholder               │      │   internal)      │      │  api.mindshub.ai │
│                                 │      │                  │      │                  │
│    HTTPS_PROXY ────────────────┼─────▶│  rewrites the    │─────▶│  real inference  │
│    = host.docker.internal:*    │      │  Authorization   │      │                  │
│    SSL_CERT_FILE (trusted CA)  │      │  header on the   │      └──────────────────┘
└───────────────────────────────┘      │  wire            │
                                        └──────────────────┘
```

## Why This Goes *Through* OneCLI, Not Around It

`docs/ollama.md` bypasses NanoClaw's OneCLI credential proxy with `NO_PROXY`,
because Ollama is a local, unauthenticated process — there's no real secret to
protect, so routing it through a credential-injecting proxy buys nothing.
MindsHub is the opposite case, and it's worth being precise about what OneCLI
actually does here, since the two situations look superficially similar but call
for opposite handling.

**What OneCLI's gateway actually is:** a transparent, host-pattern-based HTTPS
MITM proxy, injected into *every* agent container unconditionally — not
something scoped to `api.anthropic.com`. Every container's spawn already
carries `HTTPS_PROXY=http://host.docker.internal:<gateway-port>` and an
`SSL_CERT_FILE` pointing at a CA the container is told to trust (see
`src/gateway-providers/onecli.ts`, `docs/SECURITY.md` §4–5). The same mechanism
is what lets an agent call the Gmail, GitHub, or Stripe API directly and have
OneCLI silently attach the right credential (`container/skills/onecli-gateway/SKILL.md`).
It matches outbound requests by destination host and injects whatever secret is
registered for that host-pattern; a host with no registered secret just doesn't
get a credential rewritten in.

For MindsHub, that's exactly the property you want: register the real
MindsHub API key as a OneCLI secret scoped to `api.mindshub.ai`, and the
container never sees it — only the `placeholder` token does, and OneCLI swaps
it for the real Bearer credential on the wire. This is what
`setup/auto.ts`'s custom-Anthropic-endpoint flow already does for a fresh
install; the skill below does the same thing by hand for an existing one.
Bypassing the proxy for MindsHub (the Ollama approach) would mean putting your
real MindsHub key directly into the container's environment instead — worse
for credential hygiene, and pointless, since the whole reason the proxy exists
is to keep real keys out of container memory.

## Setting It Up

See [`/add-mindshub-provider`](../.claude/skills/add-mindshub-provider/SKILL.md)
for the exact commands. In short:

1. Register your MindsHub API key as a OneCLI secret, scoped to
   `api.mindshub.ai`, with header injection configured for a Bearer token.
2. Set `ANTHROPIC_BASE_URL=https://api.mindshub.ai` in `.env` (host only, no
   `/v1` — Claude Code appends `/v1/messages` itself).
3. Register the `claude` provider's container contribution by appending
   `import './claude.js';` to `src/providers/index.ts` (idempotent — already a
   no-op if it's already there).
4. Set the model per agent group with `ncl groups config update --id
   <group-id> --model <alias>` and restart.

**Scope note:** unlike Ollama's original per-group `container.json` framing,
`ANTHROPIC_BASE_URL` is read from the top-level `.env`, so this switch is
install-wide for every agent group on the `claude` provider — there is currently
no per-group override of the Anthropic base URL. Per-group model/effort
selection (step 4) still works normally on top of it.

## Network Isolation

There is no per-host `blockedHosts` config in the current codebase — that was
never actually wired into `container-config.ts`/`container-runner.ts` on `main`
(the mechanism the Ollama doc describes patching in is applied by its skill on
demand, not something that ships pre-merged). The closest equivalent today is
install-wide **egress lockdown**:

```bash
NANOCLAW_EGRESS_LOCKDOWN=true
```

With it set, agent containers run on a Docker `--internal` network with no
route to the internet except through the OneCLI gateway — see `docs/SECURITY.md`
§5. This doesn't block a specific hostname; it forces *all* egress through one
chokepoint, MindsHub calls included.

The more targeted protection is host-pattern scoping on the secret itself:
because the real MindsHub key is registered only under `api.mindshub.ai`'s
host-pattern, it can never leak to a different destination. If your install
also still has a real Anthropic secret registered from a previous standard
setup, that's fine — both can coexist in the vault; which one is used depends
entirely on which host `ANTHROPIC_BASE_URL` sends the request to.

## Model Selection

MindsHub addresses models by short alias, not raw provider model IDs. Current
catalog (see [MindsHub's model list](https://docs.mindshub.ai/inference/models)
for the authoritative, up-to-date version):

| Alias | Model | Notes |
|---|---|---|
| `sonnet` | Claude Sonnet 5 | Strong general coding, mid-range price |
| `opus` | Claude Opus 5 | Hardest reasoning tasks, most expensive |
| `haiku` | Claude Haiku 4.5 | Fast, cheap Claude |
| `fable` | Claude Fable 5 | |
| `kimi` | Kimi K3 | Agentic coding at lower cost |
| `deepseek` | DeepSeek V4-Pro-0813 | Cheapest capable option for bulk work |
| `gpt-codex` | GPT 5.3 Codex | Tuned for code |
| `gemini-flash` | Gemini 3.7 Flash | |

Set it per agent group:

```bash
ncl groups config update --id <group-id> --model sonnet
ncl groups restart --id <group-id>
```

Claude Code's own model picker (`claude-sonnet-5`, `claude-opus-5[1m]`, etc.)
also works unmodified against MindsHub — it maps real Claude model names onto
the matching alias by family, which is what lets `/model` inside the container
keep working without any NanoClaw-side translation.

One cost note specific to Claude Code: its default model maps to the `opus`
alias, one of the priciest in the catalog. Set `--model` explicitly if cost
matters, rather than relying on the CLI's own default.

## Tradeoffs

MindsHub sits in a different place than either Ollama or a direct Anthropic
account — it's a real hosted third party, so the cost/privacy tradeoffs read
differently from the local-Ollama case:

| | MindsHub | Direct Anthropic API | Ollama (local) |
|---|---|---|---|
| Cost | Pay-per-token, one bill across all models | Pay-per-token, Anthropic only | Free |
| Model choice | Claude, Kimi, DeepSeek, GPT, Gemini, and more, one key | Claude only | Whatever you've pulled |
| Privacy | Data leaves your machine to MindsHub (and, transitively, whichever upstream serves the model) | Data sent to Anthropic | Fully local |
| Latency | Network round trip to MindsHub's infra | Network round trip to Anthropic | None (local inference) |
| Model quality | Access to frontier models across vendors | Excellent (Claude) | Good (open-weight, hardware-limited) |
| Credential exposure | Real key never enters the container (OneCLI vault) | Real key never enters the container (OneCLI vault) | No real credential needed |
| Setup complexity | One `.env` var + one OneCLI secret | Default NanoClaw setup | Requires a running local Ollama + model pull |

If you want model flexibility and centralized billing without running your own
hardware, MindsHub is the middle ground between a single-vendor Anthropic
account and a fully local Ollama setup.

## Reverting to Direct Anthropic

1. Remove `ANTHROPIC_BASE_URL` from `.env`.
2. Remove (or leave — it's a no-op without `ANTHROPIC_BASE_URL`) the `import
   './claude.js';` line in `src/providers/index.ts`.
3. Remove `--model` overrides you set for MindsHub-specific aliases with `ncl
   groups config update --id <group-id> --model ""` if they aren't valid
   Claude model names.
4. Restart the service.

The MindsHub OneCLI secret can stay in the vault unused — it only matters for
requests actually sent to `api.mindshub.ai`.

## See Also

- `/add-mindshub-provider` — step-by-step skill to configure NanoClaw for MindsHub
- [MindsHub Anthropic compatibility docs](https://docs.mindshub.ai/inference/anthropic-compatibility) — the wire format Claude Code speaks against MindsHub
- [MindsHub coding agents guide](https://docs.mindshub.ai/inference/coding-agents) — Claude Code / Codex specifics, troubleshooting
- [MindsHub model catalog](https://docs.mindshub.ai/inference/models) — current aliases
- `docs/ollama.md` — the local-inference analog; explains the opposite (bypass-the-proxy) case
- `docs/SECURITY.md` — OneCLI credential injection and egress lockdown, in full
- `docs/architecture.md` — how the container spawn and env injection pipeline works
