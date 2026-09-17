# Intent: container/agent-runner/package.json modifications

## What changed
Replaced `@anthropic-ai/claude-agent-sdk` dependency with `@github/copilot-sdk`.

## Key sections
- **dependencies**: `@anthropic-ai/claude-agent-sdk` removed, `@github/copilot-sdk: "^0.1.25"` added
- All other deps unchanged: `@modelcontextprotocol/sdk`, `cron-parser`, `zod`
- All devDependencies unchanged: `@types/node`, `typescript`

## Invariants
- Package name, version, type, description, main, scripts unchanged
- MCP SDK dependency retained (used by IPC MCP server)
- Build and start scripts remain `tsc` and `node dist/index.js`

## Must-keep
- `"type": "module"` (ESM required)
- `@modelcontextprotocol/sdk` (MCP server for IPC)
- `cron-parser` and `zod` (used by agent-runner logic)
