---
name: add-rapid-mlx
description: Add Rapid-MLX local model MCP tools so a NanoClaw agent can list models, send text prompts and check server health on Apple Silicon.
---

# Add Rapid-MLX

[Rapid-MLX](https://github.com/raullenchai/Rapid-MLX) is an open-source local LLM inference server for Apple Silicon, built on MLX. This skill exposes its OpenAI-compatible API as MCP tools; the selected NanoClaw agent remains the orchestrator.

- `rapid_mlx_list_models`: list served model IDs using `/v1/models`.
- `rapid_mlx_chat`: send a text prompt, optional system prompt and token limit using `/v1/chat/completions`.
- `rapid_mlx_server_status`: check `/health`.

## Pre-flight

Check the host's server at the default OpenAI base URL, `http://localhost:8000/v1`:

```bash
curl --fail http://localhost:8000/v1/models
```

If installation is needed, use `brew install rapid-mlx`. Start a model with `rapid-mlx serve qwen3.5-4b-4bit`. When the port is omitted, Rapid-MLX picks the first free port in 8000–8009; use the port printed by the server. An explicit `--port 8000` keeps the port fixed. Reuse an existing server when one is running.

Ask which agent group should receive the tools. Use `ncl groups list` and `ncl groups config get --id <group-id>` to inspect its current configuration. Preserve all other MCP servers. Record this skill after any skill that configures the same group, so recipe replay can register its tools last.

## Apply

From the NanoClaw checkout root, copy the server and tests. Repeating these copies refreshes the same files:

```bash
cp .claude/skills/add-rapid-mlx/rapid-mlx-mcp-stdio.ts container/agent-runner/src/
cp .claude/skills/add-rapid-mlx/rapid-mlx-mcp-stdio.test.ts container/agent-runner/src/
```

Register the server for the selected group, replacing `<group-id>`. Docker Desktop reaches the host through `host.docker.internal`; `/app/src` is NanoClaw's shared read-only agent-runner source mount:

```bash
ncl groups config add-mcp-server --id <group-id> --name rapid_mlx \
  --command bun --args '["run","/app/src/rapid-mlx-mcp-stdio.ts"]' \
  --env '{"RAPID_MLX_BASE_URL":"http://host.docker.internal:8000/v1"}'
ncl groups restart --id <group-id>
```

Reapplying replaces the `rapid_mlx` configuration for that group. If the name already belongs to another integration, resolve that conflict before replacing it. For other container runtimes, use an address reachable from inside that container. The standalone server defaults to `http://localhost:8000/v1`; the registration above supplies Docker's host address explicitly.

Rapid-MLX needs no API key by default. If the server uses optional API-key authentication, follow NanoClaw's selected credential gateway workflow for bearer authorization at the target origin. Verify that requests to that origin route through the gateway before using this configuration. Keep real credentials out of MCP env and headers.

## Validate

Use the checkout's documented dependency setup (`pnpm install --frozen-lockfile` at root and `bun install --frozen-lockfile` in `container/agent-runner`) if dependencies are missing, then run:

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun test src/rapid-mlx-mcp-stdio.test.ts)
```

The test launches the real stdio MCP server against a fake HTTP service and checks tool discovery, model listing, chat payloads, health, validation and error handling. Registration is a runtime `ncl` operation with no source edit. Verify the full lifecycle on a fresh clone with its own data and provider configuration before attesting to end-to-end skill verification:

1. Inspect `ncl groups config get --id <group-id>` after registration. Confirm the command, arguments and actual server port, and that unrelated MCP entries remain intact.
2. Restart a running agent in that group. A result of `restarted: 0` means no container was restarted; start a conversation through a configured channel to spawn one before checking tool availability.
3. Ask that agent to call `rapid_mlx_server_status`, then `rapid_mlx_list_models`, then `rapid_mlx_chat` with an exact returned ID. Ask for the capital of France and check that the tool response says Paris. Inspect the actual tool calls rather than relying only on the agent's prose.
4. Follow `REMOVE.md` and confirm the restarted agent no longer exposes the tools.

The standalone MCP test does not verify group registration, a running agent restart or provider tool invocation. If provider credentials or channel setup block those steps, record exactly which steps ran and leave the end-to-end verification attestation unchecked. Use isolated provider configuration; do not borrow an existing install's credentials or state.

## Troubleshooting

- **Connection failure:** verify the host's `/v1/models`, the actual server port, and reachability of `host.docker.internal` from the agent container. Set `RAPID_MLX_BASE_URL` to that reachable base URL and re-register.
- **Unauthorized:** configure the selected credential gateway for the server origin, then retry.
- **Model not found:** list served models and use the exact ID, such as `mlx-community/Qwen3.5-4B-MLX-4bit`.
- **Tools absent:** inspect the group's `rapid_mlx` MCP config, confirm the copied source exists, and restart that group.
- **Request failed or empty text:** check Rapid-MLX's logs. Requests have a 120-second deadline including response-body reads. Reasoning models may need a larger `max_tokens` budget before returning text.

To remove the integration, follow [REMOVE.md](REMOVE.md).
