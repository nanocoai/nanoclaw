## Context

用户在 NanoClaw Codex 模式里让 agent 做代码影响分析时，会看到两段失败串起来：先提示当前环境没有暴露 `gitnexus_*` MCP 工具，再按 code-graph skill 的 fallback 流程执行 `gitnexus analyze . --name <repo> --embeddings`，最后因为数分钟无输出而降级为 `rg`、`git diff` 和人工调用链检查。

已核实的当前状态：
- Codex 模式每轮由 `container/agent-runner/src/codex-runner.ts` 生成 per-group `.codex-home/config.toml`。
- `buildCodexConfigToml()` 当前只生成 `[mcp_servers.nanoclaw]`。
- `prepareCodexHome()` 每轮覆盖 `config.toml`，手工加 GitNexus 会被下一轮擦掉。
- 本机 `gitnexus` CLI 可用，已索引 repo 例如 `nine-progress-title` 可正常查询。
- `nine-recruit-api` 目录存在，但不在 `gitnexus list` 中，触发 code-graph skill 的“未索引自动建索引”路径。

## Goals / Non-Goals

**Goals:**
- 让 Codex 模式真实拿到 GitNexus MCP server，不再只靠 prompt 里要求“必须用 GitNexus”。
- 未索引仓库 fail-visible：不要静默跑 embedding 建索引并卡住。
- GitNexus 配置显式、可审计、可测试，不把 secret 写死。
- 保留 CLI fallback，避免 MCP 注入失败时完全不可用。
- 用真实 Codex 运行证据证明工具可见和未索引行为正确。

**Non-Goals:**
- 不提供 repo allowlist 或多用户/多租户仓库级访问控制；当前按大杰单用户本机环境处理，任一 Codex 群可查询本机已索引仓库。
- 不改 GitNexus 本身的索引性能或 embedding 批处理实现。
- 不把所有全局 Codex MCP server 自动合并进 NanoClaw。
- 不重构整个 skill 安装/同步机制。

## Decisions

### D1: 用白名单注入 GitNexus MCP，不合并全局 Codex 配置

选择：扩展 `buildCodexConfigToml()`，允许 NanoClaw 显式传入白名单 extra MCP servers，并把 GitNexus 作为第一个 extra server 注入。

不选择全局 `~/.codex/config.toml` 合并，原因有三点。第一，NanoClaw 每轮覆盖 per-group `config.toml`，手改全局不等于稳定注入。第二，全局配置可能包含其他 MCP server，自动合并会扩大工具面。第三，白名单注入更容易测试和审计。

### D2: GitNexus env 从运行时读取，secret 不落源码或 per-group config

选择：生成的 per-group `CODEX_HOME/config.toml` 不写任何 GitNexus secret literal。GitNexus MCP entry 使用 wrapper 命令在进程启动时加载运行时环境：如果 `~/.gitnexus/env` 存在就 source；如果不存在也继续启动 `gitnexus mcp`。这样 secret 只存在于 MCP 子进程环境，不落到每个群的 `.codex-home/config.toml`，同时不会因为缺 embedding env 阻断已索引仓库查询。

备选是把完整 TOML 写死到代码中。这个方案被拒绝，因为 API key 会进入 git、测试 snapshot、日志或代码 review。

备选二是把 env key/value 写进 `config.toml` 的 `[mcp_servers.gitnexus.env]`。这个方案也拒绝，因为 per-group config 是普通文件，容易被调试命令、截图、日志打包或工具读取泄露。

最小依赖策略：只要 `gitnexus` command 可用，就注入 GitNexus MCP。embedding env 缺失只影响新建 embedding 索引，不影响查询已索引仓库的 `list_repos`、`context`、`impact` 等能力。

### D3: code-graph skill 未索引时 fail-visible

选择：改 `container/skills/code-graph/SKILL.md` 的流程。先 `gitnexus list`，如果 repo 不存在，明确告诉用户未索引；默认给两个可选命令：快速静态索引 `gitnexus analyze . --name <repo>`，完整语义索引 `gitnexus analyze . --name <repo> --embeddings`。只有用户确认时才执行，且必须有 timeout。

备选是继续自动跑 `--embeddings`。这个方案是当前问题根源，拒绝。

### D4: 立即补 `nine-recruit-api` 索引，但不把它当根治

选择：在本阶段任务里执行一次 `nine-recruit-api` 的 GitNexus 索引，解决当前截图触发的具体 repo。这个动作只是止血，不替代 P0/P1 修复。

### D5: E2E 验证必须证明真实 MCP 调用

选择：验证分两层。第一层是本地命令和单测，证明 TOML、wrapper 和 skill 文案正确。第二层是真实 Codex-mode turn，必须拿到一次 GitNexus MCP 成功调用证据。`.codex-home/config.toml` 里有 `gitnexus` 只能说明配置写入成功，不能单独证明 MCP server 成功启动。

合格 E2E 证据至少包含一种：Codex JSON 事件里出现 GitNexus MCP tool call 名称；Codex tool inventory 明确列出 GitNexus MCP 工具；或者用户可见回复包含一次 `gitnexus` MCP `context` / `query` / `impact` 的结果，并能通过日志或事件确认不是 CLI fallback。

CLI fallback 可单独验证，但不能替代 GitNexus MCP 可用性验收。

## Risks / Trade-offs

- [Risk] 给所有 Codex 群暴露 GitNexus MCP 后，任一群理论上能查本机所有已索引 repo。→ 当前是大杰单用户本机环境，风险接受；未来多租户再加 repo allowlist。
- [Risk] `~/.gitnexus/env` 格式变化导致 env loader 读不到配置。→ 支持进程环境优先，并在缺失时 fail-visible。
- [Risk] GitNexus MCP command 路径随 Node 版本变化。→ 使用容错 wrapper：env 文件存在才 source，不存在继续 `exec gitnexus mcp`；也可用 `GITNEXUS_BIN` 指定命令。测试覆盖 wrapper 输出而非写死单机路径。
- [Risk] E2E 中 Codex 工具列表不直接展示 MCP tools。→ 兜底用真实 MCP query/context 调用结果，并用事件或日志区分 MCP 与 CLI fallback；配置文件只能作为辅助证据。
- [Risk] wrapper 命令引用 `~/.gitnexus/env`，文件缺失时 embedding 索引不可用。→ wrapper 不因 env 文件缺失短路；`gitnexus` command 可用时仍注入，已索引仓库查询继续工作，embedding 操作在被请求时 fail-visible。

## Migration Plan

1. 在 worktree 中补 `nine-recruit-api` 索引，记录命令和结果。
2. 更新 code-graph skill，先消除自动卡住体验。
3. 修改 Codex config 生成逻辑，注入 GitNexus MCP。
4. 运行单元测试和 `npm run build`。
5. 让 C3 review 代码直到 GO。
6. 设计 E2E 用例并让 C3 review 到 GO。
7. 合并部署后执行 E2E，收集 config、日志、用户可见回复、GitNexus query 证据，再让 C3 review 到 GO 后汇报。

Rollback：如果 GitNexus MCP 注入导致 Codex 启动失败，可临时关闭 GitNexus extra server 注入，保留 code-graph skill 的 fail-visible 修复不回滚。

## Open Questions

- GitNexus MCP 的最稳 command 是固定 `gitnexus mcp`，还是读取 `GITNEXUS_BIN` 后传 `mcp`。实现阶段以本机实测为准。
- `gitnexus analyze` 无 `--embeddings` 在 `nine-recruit-api` 上的耗时是否足够短，需实测记录。

## 测试计划

P0 单元测试覆盖：
- `buildCodexConfigToml()` 同时输出 `nanoclaw` 和 `gitnexus` MCP server。
- `buildCodexConfigToml()` 的 GitNexus entry 使用 wrapper/runtime env，不把 secret 写进 generated TOML。
- 没有 GitNexus env 时仍保留 `nanoclaw` MCP，不阻断 Codex 配置生成。
- code-graph skill 文本不再包含无条件自动 `gitnexus analyze . --name <repo> --embeddings`。

P1 集成/命令验证覆盖：
- `gitnexus context ... --repo nine-progress-title` 正常返回，证明 CLI fallback 对已索引 repo 可用。
- `nine-recruit-api` 索引补建后出现在 `gitnexus list`。
- `npm run build` 编译通过。

P2 E2E 覆盖：
- 真实 Codex-mode turn 中，GitNexus MCP 至少成功调用一次；`.codex-home/config.toml` 只作为辅助证据。
- 未索引 repo 场景输出 fail-visible，不静默卡住。
