# Running agents through Ollama

NanoClaw can run an agent group through an Ollama daemon instead of calling
Anthropic. Install the provider with `/add-ollama-provider`; `ollama launch
nanoclaw` applies that provider together with `/add-local-web-chat` and opens a
loopback-only browser conversation.

## How it works

Ollama exposes an Anthropic-compatible `/v1/messages` endpoint. NanoClaw keeps
the existing Claude Agent SDK tool runtime, but the installed `ollama` provider
routes that SDK to Ollama:

```text
agent container -> http://host.docker.internal:11434 -> Ollama
```

The provider applies its routing after OneCLI configuration, supplies only an
Ollama placeholder token, blanks any Claude OAuth token, and maps Anthropic and
Claude service hostnames to `0.0.0.0` inside the container. It also disables
Claude Code's cloud-only integrations and background traffic. Interactive
browsing still uses the local `agent-browser` skill.
Ollama cloud models are still reached through the local Ollama daemon rather
than an upstream API called directly by NanoClaw.

Read the block for what it is: a hostname blackhole covering the Claude CLI's
own cloud endpoints, not general egress containment. Other traffic the container
originates is unaffected, and `NANOCLAW_EGRESS_LOCKDOWN` is not an option here
because it also severs the route to host-loopback Ollama.

## Optional Ollama web browsing

Web browsing is off by default. On first launch, the Ollama CLI offers to enable
it and clearly states that queries and fetched URLs leave the machine. Enabling
requires a free Ollama account. The CLI checks whether Ollama Cloud is enabled,
runs the normal Ollama sign-in flow if needed, and verifies both Web Search and
Web Fetch before handing the result to NanoClaw. NanoClaw saves
`OLLAMA_WEB_BROWSING=enabled` only after it accepts the launch handoff. Re-run
`ollama launch nanoclaw --config` to change the choice.

When enabled, both tools are Ollama-owned MCP adapters for the daemon's signed
endpoints:

- `WebSearch` calls `/api/experimental/web_search` directly and returns bounded
  results to the model.
- `WebFetch` calls `/api/experimental/web_fetch` for the selected result.

The direct search adapter avoids asking the model-facing Anthropic-compatible
endpoint to orchestrate its own server tool, which can hold a local turn open
for minutes even though the daemon's search endpoint responds quickly. The
provider removes and disallows the built-in server tools, so a
`server_tool_use` event cannot bypass the direct adapters.

The agent container sends both requests only to `host.docker.internal`; the
daemon signs the hosted request with the account created by `ollama signin`.
NanoClaw never mounts `~/.ollama`, never receives an Ollama API key, and never
routes these calls through OneCLI. OneCLI remains active for unrelated services
such as Google, Slack, or GitHub, because only the local Ollama hostname is in
`NO_PROXY`.

When browsing is disabled, both model-facing web tools are removed. The local
`agent-browser` remains available for interactive browser automation.

When browsing is enabled, the provider's system instructions name the direct
MCP search and fetch tools and reserve `agent-browser` for interactive or
visual work. This avoids a local model spending a full generation deciding how
to retrieve a page; it does not change the model's reasoning effort.

An `ncl` result marked `approval-pending` is also a hard wait point in the
provider instructions. The agent acknowledges it, ends the turn, and resumes
only after the host sends the actual approval outcome.

Two container environment settings bound a runaway local generation.
`CLAUDE_CODE_MAX_OUTPUT_TOKENS` (8192) ends it by output length instead of
letting it hang until the CLI's 300 second request timeout; nothing else caps
output length, since the launch alias sets `num_ctx` only and Ollama's
Anthropic-compatible layer derives `num_predict` from the request's
`max_tokens`. `CLAUDE_CODE_MAX_RETRIES=0` keeps that failure visible: with
retries, the same runaway repeats after every 300 second cancel and holds the
channel.

## Configure an existing agent group

Apply `/add-ollama-provider`, choose an exact name from `ollama list`, then run:

```bash
ncl groups config update --id <agent-group-id> --provider ollama --model <model>
ncl groups restart --id <agent-group-id>
```

The default container-visible endpoint is
`http://host.docker.internal:11434`. To use another endpoint, persist it before
restarting:

```bash
pnpm exec tsx setup/index.ts --step set-env -- \
  --key OLLAMA_BASE_URL \
  --value http://host.docker.internal:11434
```

No group `container.json`, Claude settings file, proxy, or API-key edit is
required.

## Model identity and context

The group stores the source model name selected by the operator. An `ollama
launch` install may also receive a private runtime alias from the Ollama CLI.
That alias pins the model's advertised maximum `num_ctx`; NanoClaw verifies the
live allocation before opening the browser and gives the agent runtime the same
limit for compaction. The UI and agent report the source model, not the internal
`nanoclaw/*` alias.

Persistent NanoClaw children inherit their parent's provider and source model
and use NanoClaw's normal asynchronous messaging behavior. Launch-created model
state pins Claude Code's main, alias, background, and subagent routing to the
same Ollama runtime model. Provider routing and blocked hosts are derived again
at every container spawn, so children do not fall back to another provider.
Creating a child does not end the parent's turn: the host first confirms that
the new destination is ready, then the parent can assign work. Ollama adds no
provider-specific stop rule after creation or agent messaging; the same model
turn may continue. The parent receives the child's later reports through normal
NanoClaw messages.
Ollama's system instructions also spell out that an acknowledgment alone does
not schedule background execution: a receiving child must make progress in the
current turn before it reports or ends.

Ollama cloud models manage their context in the Ollama service, so launch does
not create a local context alias for them.

For full agent workflows, choose a model with reliable multi-step tool use and
enough context for the NanoClaw prompt; parameter count alone is not a
compatibility guarantee. Local acceptance found Gemma 4 8B and 12B suitable for
basic chat but inconsistent on browser, CLI, or subagent instructions. Launch
does not add model-specific prompt workarounds for those failures.

## Warm-up and native prompt caching

`ollama launch nanoclaw` performs two different operations:

1. It sends an empty native generate request with `keep_alive: -1` to load the
   model weights.
2. When setup creates the local-web wiring, it sends `/welcome` through the
   complete NanoClaw agent prompt in that agent's exact browser conversation
   before opening the browser. Later launches and browser reconnects do not
   repeat it.

These are not two copies of the same warm-up: the first removes model-load
latency, while the second builds the real agent-prefix cache. The provider also
disables Claude Code's changing attribution header
(`CLAUDE_CODE_ATTRIBUTION_HEADER=0`) and its two recurring reminders
(`CLAUDE_CODE_TOTAL_TOKENS_REMINDER=off`, `CLAUDE_CODE_TODO_REMINDER_MODE=off`),
and keeps the runtime alias, system prompt, and session stable so Ollama's
native prefix cache can be reused on later messages. No cache proxy is needed.

Any system-role message Claude Code emits mid-conversation folds into the front
of the prompt on the qwen3.8 renderer variant, which re-prefills the
conversation behind it. Both reminders did that, so both are off. The todo knob
also removes Claude Code's todo and task nudges, so Ollama groups run without
them. Others in the same family (`date_change`, `critical_system_reminder`) are
rare and have no knob; a date rollover still costs one re-prefill.

## Local web chat

The launcher sets up a loopback browser UI so a fresh install is usable without
wiring a messaging platform. It applies `/add-local-web-chat`, opens the chat
with its access token in the URL fragment, and prints the bare
`http://127.0.0.1:3210` (set `NANOCLAW_LOCAL_WEB_PORT` for another port). The
channel and its security model are documented in the `/add-local-web-chat` skill.

The browser lists one opaque conversation per agent. Creating an agent in the
UI inherits the selected agent's provider and model unless the operator chooses
an installed override, and creates no model turn until the user sends its first
message. Replies, activity, questions, and approvals stay scoped to the selected
conversation.

The one launch-specific rule: the browser (`local-web:local`) becomes the install
owner only when no owner exists yet, mirroring the wizard's first-owner rule.
On an install that already has an owner it gets admin scoped to the launched
group instead, so launching Ollama beside an existing channel cannot mint a
second install-wide owner. That role governs what the browser user may ask an
agent to do through `ncl`. The sidebar's create and delete controls run with
host authority regardless: the access token belongs to the machine user, who
could run `ncl` directly.

## Switching away from Ollama

Select another installed provider and restart the group. For Claude:

```bash
ncl groups config update --id <agent-group-id> --provider claude
ncl groups restart --id <agent-group-id>
```

Use `.claude/skills/add-ollama-provider/REMOVE.md` only when removing the
provider code from the installation entirely.

## Troubleshooting

- **No response:** confirm `curl -sf http://localhost:11434/api/tags` succeeds.
- **Model not found:** copy the exact name shown by `ollama list`.
- **Container tries a cloud provider:** run `ncl groups config get --id <agent-group-id>`, confirm it reports
  `provider: ollama`, then restart the group.
- **Chat says it has no access token:** the tab predates the token, or its
  storage was cleared. Re-run `ollama launch nanoclaw`, or run `pnpm local-web`
  in the NanoClaw folder from the host terminal and open the URL it prints.
- **Launched before the scoped-grant change:** an existing global-owner grant is
  never downgraded, so an install that ran the old launcher still has
  `local-web:local` as a global owner. Check `ncl roles list` and revoke it if
  that is broader than you want.

See also `/add-ollama-provider`, `/add-local-web-chat`, and
`/setup-ollama-launch`.
