---
name: add-acp-server
description: Add ACP server mode — lets IDEs like Zed connect to NanoClaw as an AI agent via the Agent Client Protocol.
---

# add-acp-server — NanoClaw ACP Server Bridge

`claw-acp` makes NanoClaw available as an AI backend for any IDE that supports the
[Agent Client Protocol](https://agentclientprotocol.com) (Zed, VS Code ACP extension, `acpx`).

The IDE spawns `claw-acp` as a subprocess and communicates via ACP JSON-RPC 2.0 over stdio.
`claw-acp` bridges the requests to the running NanoClaw v2 host via the CLI Unix socket
and returns responses through the same ACP session.

## Architecture

```
IDE (Zed / acpx)  ─── ACP JSON-RPC 2.0 on stdio ───▶  claw-acp
                                                            │
                                              NanoClaw CLI socket
                                                            │
                                         NanoClaw v2 host → agent container
```

No NanoClaw source changes — `claw-acp` is a pure bridge on top of the existing CLI channel.

## Prerequisites

- NanoClaw v2 running (`systemctl --user start nanoclaw`)
- Bun installed (`bun --version`)
- The CLI channel wired to an agent group (set up via `/manage-channels` or `/init-first-agent`)

## Install

Run this skill from within the NanoClaw directory.

### 1. Copy the script

```bash
mkdir -p scripts
cp "${CLAUDE_SKILL_DIR}/scripts/claw-acp.ts" scripts/claw-acp.ts
chmod +x scripts/claw-acp.ts
```

### 2. Symlink into PATH

```bash
mkdir -p ~/bin
ln -sf "$(pwd)/scripts/claw-acp.ts" ~/bin/claw-acp
```

Make sure `~/bin` is in PATH. Add to `~/.zshrc` or `~/.bashrc` if needed:

```bash
export PATH="$HOME/bin:$PATH"
```

### 3. Verify

```bash
claw-acp --help
```

## IDE Configuration

### JetBrains (WebStorm, IntelliJ, PyCharm, …)

Create `~/.jetbrains/acp.json`:

```json
{
  "default_mcp_settings": {},
  "agent_servers": {
    "NanoClaw": {
      "command": "claw-acp",
      "args": [],
      "env": {}
    }
  }
}
```

Open AI Chat → click the agent dropdown → select **NanoClaw**.

### Zed

In `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "NanoClaw": {
      "type": "custom",
      "command": "claw-acp",
      "args": []
    }
  }
}
```

### acpx (Claude Code / Codex)

In `~/.acpx/config.json`:

```json
{
  "agents": {
    "nanoclaw": {
      "command": "claw-acp"
    }
  }
}
```

Then use it:

```bash
acpx nanoclaw "Summarize the open issues"
```

## Usage

```bash
# IDE spawns this automatically — or test manually:
claw-acp

# Verbose mode (logs ACP traffic to stderr):
claw-acp -v

# Override NanoClaw directory:
NANOCLAW_DIR=/path/to/nanoclaw claw-acp

# Restrict which files the IDE can ask the agent to read (default: $HOME):
NANOCLAW_FS_ROOT=/home/user/projects claw-acp
```

## Manual test

With NanoClaw running, open a terminal and paste these lines one at a time:

```
claw-acp
```

Then paste:

```
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"test"},"capabilities":{}}}
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"s1","prompt":[{"type":"text","text":"Hello, who are you?"}]}}
```

You should see three JSON-RPC responses: an `initialize` result, a `session/new` result with
a `sessionId`, and a `session/prompt` result with your agent's reply in a `session/update`
notification followed by `stopReason: "end_turn"`.

## Supported ACP methods

| Method | Support |
|--------|---------|
| `initialize` | Full |
| `session/new` | Full |
| `session/prompt` | Full (non-streaming) |
| `session/cancel` | Full |
| `session/close` | Full |
| `fs/read_text_file` | Full (with `line`/`limit` support) |
| `fs/write_text_file` | Not supported |

## Known limitations

- **Single active session**: NanoClaw's CLI channel supports one chat client at a time.
  A second `claw-acp` process will evict the first.
- **Non-streaming**: the full agent response is delivered as one `session/update` chunk,
  not token-by-token. IDEs display it immediately on arrival.
- **Read-only filesystem**: `fs/read_text_file` is supported; `fs/write_text_file` is not.
- **Requires running host**: `claw-acp` is a bridge — it needs the NanoClaw v2 service.

## Troubleshooting

**"CLI socket not found"** — NanoClaw is not running or `NANOCLAW_DIR` is wrong.
Run `systemctl --user start nanoclaw` and check `data/cli.sock` exists.

**No response** — The CLI channel may not be wired to an agent group. Run `/manage-channels`
or check that an agent is wired to the `cli` channel in the NanoClaw UI.

**Wrong NanoClaw directory** — Set `NANOCLAW_DIR=/path/to/your/nanoclaw` in the IDE's
environment or in `~/.bashrc`.
