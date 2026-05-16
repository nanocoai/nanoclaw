## Why

Anthropic 2026-06-15 起将 Agent SDK 调用独立计费（每账号 $20-200/月信用额度），与交互式 CLI 配额分离。NanoClaw 当前通过 `@anthropic-ai/claude-agent-sdk` 的 `query()` API 运行 Agent，所有调用将被计入 Agent SDK 信用池。通过支持交互式 CLI 模式（spawn `claude` 进程 + stdin/stdout 通信），可以让指定群的调用走交互式配额，避免 Agent SDK 信用额度耗尽。

## What Changes

- 新增交互式 CLI 运行模式，作为 Agent SDK `query()` 的替代方案
- Per-group 可配置：通过 `container_config.useCliMode: true` 控制
- CLI 模式通过 spawn 交互式 `claude` 进程 + stdin/stdout JSON 通信实现
- 保留所有现有能力：session resume、model override、MCP tools、streaming output、hooks
- 两种模式共存，不影响未标记群的正常运行

## Capabilities

### New Capabilities
- `cli-runner`: 交互式 CLI 运行器，替代 Agent SDK query()，支持 spawn claude 进程 + stdin/stdout 通信、session 管理、model override、MCP server 挂载
- `cli-mode-config`: Per-group CLI 模式配置，通过 container_config 字段控制运行模式切换

### Modified Capabilities
（无现有 spec 需要修改）

## Impact

- **agent-runner/src/index.ts**：新增 CLI 模式分支，与现有 SDK 模式并存
- **src/container-runner.ts**：读取 `useCliMode` 配置，传递给 agent-runner
- **src/types.ts**：`ContainerConfig` 新增 `useCliMode` 字段
- **依赖**：不新增依赖，使用 Node.js 内置 `child_process.spawn`
- **兼容性**：100% 向后兼容，默认仍走 Agent SDK 模式
