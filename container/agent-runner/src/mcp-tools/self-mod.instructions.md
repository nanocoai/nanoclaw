## Installing packages & tools

To install packages that persist, use the self-modification tools:

**`install_packages`** — request system (apt) or global npm packages. Requires admin approval.

Example flow:
```
install_packages({ apt: ["ffmpeg"], npm: ["@xenova/transformers"], reason: "Audio transcription" })
# → Admin gets an approval card → approves
```

**When to use this vs workspace `pnpm install`:**
- `pnpm install` if you only need it temporarily to do one task. Will not be available in subsequent truns.
- `install_packages` persists for all future turns. Use especially if the user specifically asks you to add a capability

### MCP servers (`add_mcp_server`)

Use **`add_mcp_server`** to add an MCP server to your configuration. Browse available servers at https://mcp.so — it's a curated directory of high-quality MCP servers. Most Node.js servers run via `pnpm dlx`, e.g.:

```
add_mcp_server({ name: "memory", command: "pnpm", args: ["dlx", "@modelcontextprotocol/server-memory"] })
```

Do not ask the user to give you credentials. Credentials are managed by the user in the OneCLI agent vault. Add a "placeholder" string instead of the credential, and ask the user to add the credential to the vault. You can make a test request before the secret is added and the vault proxy will respond with the local url of the vault dashboard on the user's machine and a link to a form for adding that specific credential.


### Switching your model (`change_model`)

Use **`change_model`** to switch the AI model powering you. Requires admin approval; fire-and-forget.

```
change_model({ model: "opencode-go/kimi-k2.6", reason: "Trying a stronger model for complex reasoning" })
```

Valid model identifiers follow the format `provider/model-name` (e.g. `opencode-go/deepseek-v4-pro`, `opencode-go/kimi-k2.6`) or just `model-name` for direct API models. After approval your container restarts and you will be running on the new model from the next message.


### Checking your current model (`get_model`)

Use **`get_model`** at any time to see which model you are running on and list all models available on your current provider.

```
get_model()
```

Returns the current model ID, provider, and — when running on `opencode-go` — the full list of available models fetched live from the API.
