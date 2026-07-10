# 可读过程卡片 Real E2E 计划

## 目标与判定边界

真实飞书链路验证用户实际看到的卡片、同卡更新和过程记录。配置存在、单元测试通过、日志声称成功都不能替代飞书消息证据。

取消、缺少 completion、限流重试依赖不可稳定控制的 provider 时序，不在真实账号上伪造通过：它们以结构化协议探针和全量回归作为补充证据，不能计入 Real E2E 通过数。

## 环境准备

1. PR 以 merge commit 合入 `main`，本机 `git rev-parse HEAD` 与 merge commit 一致。
2. 在 NanoClaw 根目录执行 `npm run build`，用 `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` 重启。
3. 确认只有一个 `dist/index.js` 主进程，并记录启动时间、PID、merge commit。
4. 从注册群配置中选择一个 Claude 群和一个 Codex 群；不得临时修改生产群模式。
5. 每条用例使用唯一 marker：`RPC-<ID>-<epoch>`，逐条发送、逐条取证。
6. 原始证据写入 `/tmp/nanoclaw-artifacts/readable-progress-cards/`，不把用户消息和内部标识提交进 Git。

## 统一证据要求

每个 Real E2E 用例必须保存：

- 用户触发消息的 `message_id`、群 ID、marker 和发送时间；
- 对应 interactive 卡的 `message_id`、完整 card JSON、`updated` 和 `reply_to`；
- 最终回复内容；
- 卡片中“过程记录”链接对应的步骤快照；
- 同一时间窗 NanoClaw 日志摘录，确认没有未处理异常。

用户可见卡片必须反向断言不含：`zsh -lc`、`bash -lc`、绝对路径、`oc_`/`om_`/trace ID、内部地址、裸 `mcp_tool_call` 和重复“结果”行。

## Real E2E 用例

### RPC-01 Claude 常见动作语义

在 Claude 群发送：先读取 `package.json`，搜索构建脚本，向 `/tmp` 写入 marker 文件，再运行一个安全的定向测试；要求使用实际工具，不只口头描述。

通过标准：同一张过程卡依次出现读取、搜索、修改、测试类用户动作；原始命令和路径为零；最终回复正常送达；过程记录仍能看到有界命令依据。

### RPC-02 真实计划归属

在 Claude 群发送：先用真实计划工具建立三项计划，其中第一项完成、第二项进行中、第三项待处理；随后在第二项下执行安全测试。

通过标准：卡片展示三项真实状态；测试动作标题带第二项计划作为父阶段；不得额外生成一条无阶段的重复测试步骤，也不得根据命令预测第四项计划。

### RPC-03 复杂脚本保守降级

在 Claude 群发送：先明确说明“汇总本地三次计时结果”，再运行只输出 marker 和三组数字的 Python heredoc。

通过标准：脚本动作归入“汇总本地三次计时结果”阶段，使用“分析脚本/系统检查”类保守文案；卡片不得声称已经定位根因或展示 heredoc 正文。

### RPC-04 MCP 业务语义

在 Claude 群触发一次 `search_chat`，查询当前 marker，并返回匹配数量。

通过标准：卡片显示“搜索聊天记录”或等价业务动作；不得出现裸 `mcp_tool_call`；结果回到原步骤，卡片与过程记录均无重复结果行。

### RPC-05 Codex started/completed 同卡更新

在 Codex 群执行与 RPC-01 等价的读取和安全测试任务。

通过标准：用户语义与 Claude 同类动作一致；结构化日志中 started/completed 使用相同 item ID；飞书只保留一条对应步骤并从“正在”更新为终态。

### RPC-06 失败如实展示

在 Claude 或 Codex 群运行受控命令 `sh -c 'echo <marker> >&2; exit 7'`，不得附带破坏性操作。

通过标准：对应步骤显示失败，不显示完成；最终回复仍送达；过程记录保留有界错误依据；默认卡片不出现命令正文。

### RPC-07 技术详情分层

复用 RPC-01、RPC-05、RPC-06 的三张卡进行横向核对。

通过标准：三张默认卡技术泄露计数均为 0；三个过程记录均包含足以对应真实调用的有界详情；普通日志不新增完整参数副本。

## 协议与降级补充验证

以下不计入 Real E2E 通过数，但必须随证据报告：

1. print `user/tool_result`、SDK 空内容 `is_error`、Codex `cancelled/canceled/interrupted` 的结构化映射测试。
2. 工具步骤滑出三行窗口后，完成事件仍更新过程记录的测试。
3. turn 结束缺 completion 时持久化“结果未知”的测试。
4. 畸形 structured progress 使用安全 fallback 的测试。
5. `NANOCLAW_READABLE_PROGRESS=0` 恢复旧展示且不影响最终回复的测试。
6. 限流重试直接复用 `mainOnOutput`，序列化结果含 progress 的测试和源码证据。

## 通过门槛

- RPC-01 至 RPC-07 全部通过，任何一条缺少真实 interactive card JSON 即失败。
- 默认卡片 raw command、绝对路径、内部 ID、裸 MCP 名和重复结果行均为 0。
- Claude/Codex 核心动作语义一致，失败不误报成功。
- 补充协议验证全部通过，但在报告中与 Real E2E 分栏，不混算。
- 证据交 C2 复核，C2 明确 GO 后才能向用户汇报完成。
