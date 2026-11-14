# Intent: container/agent-runner/src/index.ts modifications

## What changed
Added Claude Code MCP server registration so main-group agents can delegate coding tasks to the host.

## Key sections

### runQuery() signature
- Added: `claudeCodeProxyPath` parameter (5th positional, after `qmdProxyPath`)

### MCP servers config (inside runQuery)
- Extracted: `mcpServers` from inline object to a variable built conditionally
- Added: `claude-code` MCP server entry, **only when `containerInput.isMain === true`**
- Spawn config: `{ command: 'node', args: [claudeCodeProxyPath], env: { CLAUDE_CODE_PORT: '8282' } }`
- Existing servers (nanoclaw, qmd, gmail, google-workspace) are unchanged

### allowedTools (inside runQuery)
- Extracted: `allowedTools` from inline array to a variable
- Added: `'mcp__claude-code__*'` pushed onto array, **only when `containerInput.isMain === true`**
- All existing tool permissions are unchanged

### main()
- Added: `claudeCodeProxyPath` constant alongside `mcpServerPath` and `qmdProxyPath`
- Updated: `runQuery()` calls pass the new path parameter

## Security
- Non-main groups do NOT get the claude-code MCP server registered
- Non-main groups do NOT get `mcp__claude-code__*` in allowedTools
- This prevents non-main agents from accessing host filesystem via Claude Code

## Invariants
- All existing MCP servers are preserved (nanoclaw, qmd, gmail, google-workspace)
- All existing tool permissions are preserved
- MessageStream, IPC polling, hooks are completely unchanged
- Input/output protocol is unchanged
- Session management is unchanged
