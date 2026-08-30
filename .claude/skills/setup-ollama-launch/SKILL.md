---
name: setup-ollama-launch
description: 'Install the NanoClaw side of `ollama launch nanoclaw`: compose the Ollama provider with the standalone local web chat, create the local agent, and start it on the selected model. Use for the Ollama CLI integration, not general NanoClaw setup.'
---

# Set up Ollama launch

This skill owns the deterministic NanoClaw entrypoint called by
`ollama launch nanoclaw`. The launcher composes `/add-ollama-provider` with the
provider-neutral `/add-local-web-chat` skill, creates or reuses the local agent,
registers the loopback browser as the install's first owner (or, when the install
already has one, as an admin scoped to the launched group), and gives the browser
its own session without creating another agent identity.

## Apply

### 1. Build and validate

The launch integration test is tracked on main at
`scripts/ollama-launch.test.ts` (it needs no channel/provider payload), so
main CI runs it; this step re-verifies it on the install.

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run scripts/ollama-launch.test.ts
```

## Run the deterministic launcher

```bash
bash .claude/skills/setup-ollama-launch/scripts/launch.sh \
  --model <source-ollama-model> \
  --runtime-model <ollama-launch-context-alias> \
  --base-url http://127.0.0.1:11434 \
  --web-browsing <enabled-or-disabled> \
  --context-length <model-maximum> \
  --display-name <operator-name> \
  --agent-name Ollama
```

On success it prints `http://127.0.0.1:3210` and opens that address with the
browser's access token in the URL fragment; the page stores the token and strips
it, so the address bar shows the bare URL. Override the port with
`NANOCLAW_LOCAL_WEB_PORT`; the launcher persists that port for the service.
The browser uses the normal `local-web:local` user, membership, and role. It
becomes the install owner, with global CLI scope so it can create persistent
agents without an approval detour, only when the install has no owner yet;
otherwise it gets admin scoped to the launched group.
When setup creates the local-web wiring, it queues the standard `/welcome` turn
once through the normal channel path; later launches and browser reconnects do
not repeat it.

The Ollama CLI owns the browsing consent, sign-in, cloud-status check, and live
Web Search/Web Fetch probes. The launcher accepts only the verified
`enabled|disabled` result; NanoClaw persists it for the host provider only after
the launch handoff succeeds. Browsing calls
still go through the local Ollama daemon; NanoClaw neither receives nor stores an
Ollama API key. Re-run `ollama launch nanoclaw --config` to change the choice.

Model identity, context handling, warm-up, and the rest of the provider's
behavior: `docs/ollama.md`.

## Troubleshooting

See `/add-local-web-chat` for browser, port, and wiring failures, and
`docs/ollama.md` for model and provider failures.
