# OpenRouter and DeepSeek provider setup

NanoClaw's OpenCode provider is installed with SDK and CLI version `1.4.17`.
The household group is configured to use these non-secret values:

```text
provider=opencode
OPENCODE_PROVIDER=openrouter
OPENCODE_MODEL=openrouter/deepseek/deepseek-v4-flash
OPENCODE_SMALL_MODEL=openrouter/deepseek/deepseek-v4-flash
ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1
```

Model selection belongs to group configuration, not application code. Changing
the model therefore requires a group configuration update and restart only.

## Credential gate

No OpenRouter credential is stored in this checkout, group configuration,
environment file, service unit, command history, or playbox fixture. When an
operator supplies a key, enter it only through OneCLI's masked local UI using:

- Name: `OpenRouter`
- Type: `generic`
- Host pattern: `openrouter.ai`
- Header: `Authorization`
- Value format: `Bearer {value}`

After OneCLI confirms storage, create an expendable OpenCode group and request
the exact response `MODEL_OK`. Confirm OpenRouter attributes the request to
DeepSeek V4 Flash, then remove only the expendable group. This live-provider
check is intentionally separate from the deterministic local playbox gate.

## Recovery

If OpenCode fails to start, verify that both the CLI and SDK report version
`1.4.17`, rebuild the agent image, and restart the group. If authentication
fails, inspect only OneCLI credential metadata and host matching; never copy the
secret into an environment variable or diagnostic command.
