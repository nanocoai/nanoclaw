# 可读过程卡片 Real E2E 计划

## 目标效果冻结

默认卡片不是工具日志摘要，而是用户任务进度。每个可见行必须以任务阶段为主体，并在信息可得时包含动作、对象和结果。工具调用只更新阶段，完整命令只进入过程记录。

固定用例的终态目标如下；允许不改变含义的少量连接词差异，不允许删掉阶段目标、对象或结果：

| 用例 | 终态卡片必须表达 |
|---|---|
| RPC-01 | `核对进度展示链路 · 已读取 input.txt、搜索“readable-progress-needle”、修改 <marker>.txt，并测试 fixture.test.mjs（1 项通过）` |
| RPC-02 | `核对 fixture` 已完成；`运行长测试 · 已测试 fixture.test.mjs（1 项通过）` 已完成；`整理证据` 进行中 |
| RPC-03 | `汇总本地三次计时结果 · 已获得 3 个计时值` |
| RPC-04 | `核对目标聊天记录 · 找到 1 条匹配消息`，运行态必须显示搜索 marker 而非“协作操作” |
| RPC-05 | `验证 Codex 执行链路 · 已读取 input.txt、搜索“readable-progress-needle”，并测试 fixture.test.mjs（1 项通过）` |
| RPC-06 | `验证失败状态展示 · 命令执行失败（退出码 7）` |

以下任一情况直接判定 Real E2E 失败，不得用日志或过程记录补救：

- 最终卡只剩“已完成搜索”“已完成读取”“已完成修改”“已完成协作操作”“已执行系统检查”“已执行分析脚本”等孤立分类标签。
- 同一任务阶段的多个工具调用分别占行，导致阶段目标或结果被最近三条窗口挤掉。
- 完成态比开始态信息更少，例如“正在搜索聊天记录”完成后变成“已完成协作操作”。
- 上游结果已有明确数量、通过/失败或退出码，但默认卡仍只显示“完成/失败”而不显示结果。
- 上游参数已有安全对象，但默认卡仍只显示“读取文件”“搜索相关内容”“修改文件”“运行测试”等动作空壳。

每条用例的截图验收人只看默认卡片，不得先打开过程记录。截图必须让其直接回答四个问题：任务目标是什么、当前或已经做了什么、对象是什么、结果怎样。上游确有信息但任一答案缺失，当前用例失败。

## 判定边界

本计划包含 6 条 Real E2E 和 1 条证据审计。Real E2E 必须在真实飞书界面观察 interactive card，配置、单测、日志、消息降级文本、过程记录或最终回复均不能单独判通过。证据审计复用 Real E2E 产物，不虚增 E2E 数量。

取消、缺少 completion、限流重试依赖不可稳定控制的 provider 时序，只作为协议探针，不计入 Real E2E 通过数。

## 部署前置

1. PR 以 merge commit 合入 `main`，记录 merge commit。
2. 在 NanoClaw 根目录执行 `npm run build`，再执行 `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`。
3. 确认只有一个 `dist/index.js` PID，并核对 `dist` 生成时间晚于 merge commit checkout 时间。
4. 从注册群配置中选择一个 Claude 群和一个 Codex 群，不临时修改生产群模式。
5. 每条用例使用 `RPC-<ID>-<epoch>` marker，逐条发送、逐条等待、逐条取证。
6. 证据写入 `/tmp/nanoclaw-artifacts/readable-progress-cards/`，不提交用户消息、群 ID 和内部标识。

## 固定 fixture

执行者在发消息前创建同一套无敏感信息的临时 fixture：

```bash
FIXTURE=/tmp/nanoclaw-readable-progress-fixture
mkdir -p "$FIXTURE"
printf 'readable-progress-needle\n' > "$FIXTURE/input.txt"
cat > "$FIXTURE/fixture.test.mjs" <<'EOF'
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('readable progress fixture', async () => {
  await new Promise((resolve) => setTimeout(resolve, 10000));
  assert.match(fs.readFileSync('/tmp/nanoclaw-readable-progress-fixture/input.txt', 'utf8'), /readable-progress-needle/);
});
EOF
```

长测试固定耗时约 10 秒，专门留出 started 卡取证窗口。任何模型跳过指定工具、合并本应独立的调用或只口头复述，当前用例直接失败，不接受“语义差不多”。

## 统一取证方法

### 飞书界面双截图

发送 prompt 后用消息列表定位 marker 和卡片出现时间，命令输出仅作为消息关联辅助证据，不宣称包含原始 interactive card JSON：

```bash
LARK_CLI_NO_PROXY=1 lark-cli im +chat-messages-list \
  --chat-id <chat_id> --page-size 20 --order desc --format ndjson
```

执行者须打开目标群的真实飞书桌面端或 Web 页面。长测试运行中，一旦界面出现包含阶段目标的 running 步骤，立即保存完整窗口截图为 `started.png`；工具结束但最终卡片仍可见时，再保存完整窗口截图为 `terminal.png`。截图必须能同时辨认群、marker 时间窗、卡片标题、阶段目标、当前动作和结果，不得只截裁掉上下文的局部卡片。

同卡原地更新必须同时满足：

- 两张真实飞书界面截图分别显示“正在运行测试”和“已完成测试”或“测试失败”；
- 同一时间窗内的 `[progress-state] 工具步骤状态更新` 日志中，started 和 terminal 使用相同 `cardMessageId` 与 `toolCallId`；
- 日志中的 `stepCount` 前后相同，`fromStatus/toStatus` 明确出现 `missing→running` 和 `running→completed|failed`；
- terminal 截图不出现独立“结果”行。截图、状态日志任一缺失均不得判定同卡更新通过。
- started 与 terminal 截图中的阶段目标和操作对象保持一致；terminal 只能更新状态与结果，不得退化为分类名称。

过程卡使用 `im.message.create` 创建，预期 `reply_to` 为空。测试只记录该字段，不要求它指向触发消息。消息关联使用 `chat_id + marker + 发送时间窗 + NanoClaw 结构化日志`。

### 结构化日志

`[progress] 转发到 channel` 日志必须包含且只使用这些关联字段：`chatJid`、`provider`、`lifecycle`、`toolName`、`toolCallId`。`[progress-state] 工具步骤状态更新` 日志必须包含 `cardMessageId`、`toolCallId`、`stepCount`、`fromStatus`、`toStatus`。两类日志都不得记录 input、command 或结果正文。

Codex started/completed 通过同一时间窗内 `provider=codex` 且相同 `toolCallId` 对账，再与相同 `cardMessageId` 的状态日志和飞书界面双截图交叉验证。

### 过程记录

从卡片中的“过程记录”链接读取步骤快照。默认卡片反向断言不含 `zsh -lc`、`bash -lc`、绝对路径、`oc_`/`om_`/trace ID、内部地址、裸 `mcp_tool_call` 和重复结果行。过程记录必须保留有界技术依据，同时不含 synthetic canary 或疑似凭证原文。

## 6 条 Real E2E

### RPC-01 Claude 单阶段四类动作聚合

完整 prompt：

> E2E `<marker>`。先单独输出一句过程说明“核对进度展示链路”。随后必须按顺序实际执行四个独立工具调用，不得合并、跳过或只口头说明：1）用 Read 读取 `/tmp/nanoclaw-readable-progress-fixture/input.txt`；2）用 Grep 在该文件搜索 `readable-progress-needle`；3）用 Write 写入 `/tmp/nanoclaw-readable-progress-fixture/<marker>.txt`，内容只写 marker；4）用 Bash 执行 `node --test /tmp/nanoclaw-readable-progress-fixture/fixture.test.mjs`。完成后只汇报四步结果。

通过标准：结构化日志和过程记录都出现四个独立调用；默认卡只显示一个“核对进度展示链路”阶段，运行中展示当前动作，终态表达读取、搜索、修改和 1 项测试通过；不得出现四条孤立工具行；测试运行中和完成后按统一方法取得同卡双截图与状态日志；默认卡无原始命令和路径。

### RPC-02 TodoWrite 计划与父阶段

完整 prompt：

> E2E `<marker>`。先实际调用 TodoWrite 创建且只创建三项计划：`核对 fixture`=completed、`运行长测试`=in_progress、`整理证据`=pending。计划创建后，必须单独用 Bash 执行 `node --test /tmp/nanoclaw-readable-progress-fixture/fixture.test.mjs`，测试结束前不要再次更新计划。测试结束后再把第二项改为 completed、第三项改为 in_progress，最后返回 marker。

取证时点：第一次在真实飞书界面看到三项计划后保存 `plan-started.png`；10 秒长测试运行中再保存 `plan-running.png`；最终计划更新后保存 `plan-terminal.png`。

通过标准：前两份快照中第二项均为进行中；测试动作更新“运行长测试”阶段，不出现无 phase 的重复测试行；最终快照固定为“核对 fixture”完成、“运行长测试 · 1 项测试通过”完成、“整理证据”进行中；未生成第四项计划，也不得出现 TaskCreate/TaskUpdate 的系统检查行。

### RPC-03 Python heredoc 保守降级

完整 prompt：

> E2E `<marker>`。先单独输出一句过程说明“汇总本地三次计时结果”。然后必须用 Bash 原样执行一个 Python heredoc：打印 marker 和 `10,20,30`，并 sleep 8 秒；不要调用其他工具。最后只复述输出数字，不推断根因或后续修复。

其中“原样执行”的命令固定为：

```bash
python3 - <<'PY'
import time
print('<marker> 10,20,30')
time.sleep(8)
PY
```

通过标准：运行中卡片显示“汇总本地三次计时结果 · 正在运行分析脚本”；终态显示“汇总本地三次计时结果 · 已获得 3 个计时值”或信息等价文案；不得只显示“已执行分析脚本/系统检查”；卡片不展示 heredoc，不声称定位根因，不生成未来计划。

### RPC-04 MCP 业务语义

先向同一群发送一条独立种子消息 `<marker>-seed`，确认 lark-cli 已能读取该消息后，再发送测试 prompt；搜索目标固定为完整种子 marker，避免搜索索引里没有正样本。

完整 prompt：

> E2E `<marker>`。先单独输出一句过程说明“核对目标聊天记录”。随后必须实际调用一次 `search_chat` 搜索完整字符串 `<marker>-seed`，不得用 shell、文件搜索或口头假装搜索。完成后返回匹配数量。

通过标准：结构化日志出现真实 MCP 工具调用；运行中卡片显示“核对目标聊天记录 · 正在搜索聊天记录”；终态显示“核对目标聊天记录 · 找到 1 条匹配消息”；不出现裸 `mcp_tool_call`、“已完成协作操作”或独立结果行。

### RPC-05 Codex 同卡 started/completed

完整 prompt：

> E2E `<marker>`。先单独输出一句过程说明“验证 Codex 执行链路”。随后必须依次执行三个独立 command_execution，不得合并：1）`sed -n '1p' /tmp/nanoclaw-readable-progress-fixture/input.txt`；2）`rg -n 'readable-progress-needle' /tmp/nanoclaw-readable-progress-fixture/input.txt`；3）`node --test /tmp/nanoclaw-readable-progress-fixture/fixture.test.mjs`。不得替换测试命令。完成后返回 marker。

通过标准：日志中第三个命令的 started/completed 使用相同 `toolCallId`；10 秒窗口内保存 running 卡界面截图，结束后保存 terminal 卡界面截图；默认卡只显示“验证 Codex 执行链路”阶段，终态表达读取、搜索和 1 项测试通过；状态日志的 `cardMessageId`、`toolCallId`、`stepCount` 前后一致且状态 running→completed；Claude/Codex 的阶段聚合与结果语义一致。

### RPC-06 Codex 失败终态

完整 prompt：

> E2E `<marker>`。先单独输出一句过程说明“验证失败状态展示”。随后必须实际执行且只执行一个命令 `sh -c 'echo <marker> >&2; exit 7'`，不得改写退出码、不得重试。随后如实说明失败。

通过标准：Codex completed 事件 exit code 为 7；原阶段更新为“验证失败状态展示 · 命令执行失败（退出码 7）”或信息等价文案；不得只显示“执行失败”；最终回复正常送达；过程记录保留有界错误依据；默认卡不显示命令正文。

## 证据审计 RPC-AUDIT-01

复用 RPC-01 至 RPC-06 的卡片和过程记录，统计并报告：默认卡 raw command、绝对路径、内部 ID、裸 MCP 名、重复结果行和孤立分类标签均为 0；六张终态卡均能回答目标、动作、对象、结果四个问题；过程记录均有调用依据；普通日志没有完整参数和结果正文。此项是横向审计，不计为第 7 条 Real E2E。

## 协议探针

以下必须随报告提供测试名和 PASS 输出，但不计 Real E2E：

1. print `user/tool_result`、SDK 空内容 `is_error`、Codex `cancelled/canceled/interrupted` 映射。
2. 工具步骤滑出三行窗口后仍更新过程记录。
3. turn 结束缺 completion 时持久化“结果未知”。
4. 畸形 structured progress 使用安全 fallback。
5. `NANOCLAW_READABLE_PROGRESS=0` 回退旧展示。
6. 限流重试复用 `mainOnOutput`，序列化结果含 progress。
7. 同一张表驱动 synthetic canary 同时调用 runner 与 host 两份脱敏器，覆盖 Bearer、API key、带凭据 URL、query token、私钥、GitHub token、Slack token 和 AWS access key；两端输出一致且均不含原值。

## 通过门槛

- RPC-01 至 RPC-06 全部通过，缺任何一份要求的真实飞书界面截图或状态日志即失败。
- RPC-AUDIT-01 的五类泄露/重复计数全部为 0。
- 六张终态卡的孤立分类标签计数为 0，且目标、动作、对象、结果四项信息完整性全部通过。
- 协议探针全部通过，并与 Real E2E 分栏汇报。
- 证据交 C2 复核，C2 明确 GO 后才能向用户汇报完成。
