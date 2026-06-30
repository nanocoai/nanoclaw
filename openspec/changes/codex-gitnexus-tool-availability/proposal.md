## Why

NanoClaw 的 Codex 模式里，用户让 agent 做代码影响分析时，经常看到“当前环境没有暴露 `gitnexus_*` MCP 工具”，随后 fallback 到 `gitnexus analyze --embeddings` 并卡住数分钟。用户实际看到的是工具“老是用不了”：本该先走 GitNexus 的代码图谱查询，最后退化成 `rg`、`git diff` 和人工调用链检查。

这个问题现在需要修，因为 AGENTS.md 已经把 GitNexus 影响分析写成改代码前的硬要求，但 Codex 运行时没有注入 GitNexus MCP；同时 code-graph skill 在仓库未索引时会自动跑耗时 embedding 建索引，没有确认、进度、超时和降级边界。

## What Changes

- 更新 code-graph skill 的未索引仓库处理：默认不再静默执行 `gitnexus analyze --embeddings`；必须 fail-visible，并提供可确认的快速索引/完整 embedding 索引路径。
- 为 Codex 模式生成的 `config.toml` 增加白名单式 extra MCP 注入能力，并把 GitNexus MCP 显式注入到 Codex runtime。
- GitNexus MCP 通过 wrapper/runtime env 获取配置；禁止把 API key 写死到源码、OpenSpec、测试 fixture、生成日志或 per-group `config.toml` 里。
- 补齐单元测试、真实 Codex 配置验证和 E2E 验证：证明 `gitnexus_*` 工具可见，未索引仓库不会静默卡住，已索引仓库能直接查询。
- 立即为 `nine-recruit-api` 补建本机 GitNexus 索引，解决当前触发用户问题的具体仓库。

## Capabilities

### New Capabilities

- `codex-gitnexus-tooling`: Codex 模式下的 GitNexus 工具可用性、配置注入、未索引仓库 fail-visible 行为和验证闭环。

### Modified Capabilities

- 无。

## Impact

- **代码**: `container/agent-runner/src/codex-runner.ts` 增加 extra MCP 配置生成；相关测试覆盖 config TOML 输出。
- **Skill**: `container/skills/code-graph/SKILL.md` 更新未索引仓库流程，移除自动无确认 `--embeddings` 行为。
- **配置**: 读取 `~/.gitnexus/env` 或环境变量中的 GitNexus embedding 配置；不引入新的数据库 schema。
- **运行时**: Codex 每轮生成的 `.codex-home/config.toml` 将包含 `nanoclaw` 和白名单注入的 `gitnexus` MCP server。
- **安全**: GitNexus MCP 只暴露本机已索引仓库的图谱查询能力；不做多租户仓库隔离，本阶段按大杰单用户本机环境处理。
