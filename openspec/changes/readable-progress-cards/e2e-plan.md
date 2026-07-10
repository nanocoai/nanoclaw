# 可读过程卡片 Real E2E 计划

## 判定边界

本计划包含 6 条 Real E2E 和 1 条证据审计。Real E2E 必须读取真实飞书 interactive card，配置、单测、日志或最终回复均不能单独判通过。证据审计复用 Real E2E 产物，不虚增 E2E 数量。

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

### 飞书双快照

发送 prompt 后每秒拉一次消息：

```bash
LARK_CLI_NO_PROXY=1 lark-cli im +chat-messages-list \
  --chat-id <chat_id> --page-size 20 --sort desc --format ndjson
```

长测试运行中，一旦卡片出现 running 测试步骤，立即保存原始输出为 `started.ndjson`；最终回复到达后再次拉取并保存为 `terminal.ndjson`。

同卡原地更新必须同时满足：

- 两份 raw interactive JSON 的 `message_id` 完全相同；
- started 快照包含“正在运行测试”，terminal 快照变为“已完成测试”或“测试失败”；
- 对应步骤数量不增加，不出现独立“结果”行；
- `updated` 只作辅助证据，不单独判通过。

过程卡使用 `im.message.create` 创建，预期 `reply_to` 为空。测试只记录该字段，不要求它指向触发消息。消息关联使用 `chat_id + marker + 发送时间窗 + NanoClaw 结构化日志`。

### 结构化日志

`[progress] 转发到 channel` 日志必须包含且只使用这些关联字段：`chatJid`、`provider`、`lifecycle`、`toolName`、`toolCallId`。不得依赖不存在的 runner 原始 NDJSON，也不得记录 input、command 或结果正文。

Codex started/completed 通过同一时间窗内 `provider=codex` 且相同 `toolCallId` 对账，再与同 message ID 的飞书双快照交叉验证。

### 过程记录

从卡片中的“过程记录”链接读取步骤快照。默认卡片反向断言不含 `zsh -lc`、`bash -lc`、绝对路径、`oc_`/`om_`/trace ID、内部地址、裸 `mcp_tool_call` 和重复结果行。过程记录必须保留有界技术依据，同时不含 synthetic canary 或疑似凭证原文。

## 6 条 Real E2E

### RPC-01 Claude 固定四类动作

完整 prompt：

> E2E `<marker>`。必须按顺序实际执行四个独立工具调用，不得合并、跳过或只口头说明：1）用 Read 读取 `/tmp/nanoclaw-readable-progress-fixture/input.txt`；2）用 Grep 在该文件搜索 `readable-progress-needle`；3）用 Write 写入 `/tmp/nanoclaw-readable-progress-fixture/<marker>.txt`，内容只写 marker；4）用 Bash 执行 `node --test /tmp/nanoclaw-readable-progress-fixture/fixture.test.mjs`。完成后只汇报四步结果。

通过标准：结构化日志和过程记录都出现四个独立调用；默认卡展示读取、搜索、修改、测试四类动作；测试运行中和完成后按统一方法取得同卡双快照；默认卡无原始命令和路径。

### RPC-02 TodoWrite 计划与父阶段

完整 prompt：

> E2E `<marker>`。先实际调用 TodoWrite 创建且只创建三项计划：`核对 fixture`=completed、`运行长测试`=in_progress、`整理证据`=pending。计划创建后，必须单独用 Bash 执行 `node --test /tmp/nanoclaw-readable-progress-fixture/fixture.test.mjs`，测试结束前不要再次更新计划。测试结束后再把第二项改为 completed、第三项改为 in_progress，最后返回 marker。

取证时点：第一次看到三项计划后保存 `plan-started.ndjson`；10 秒长测试运行中再保存 `plan-running.ndjson`；最终计划更新后保存 `plan-terminal.ndjson`。

通过标准：前两份快照中第二项均为进行中；测试动作以“运行长测试”为父阶段，不出现无 phase 的重复测试行；最终快照第二项完成、第三项进行中；未生成第四项计划。

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

通过标准：卡片将脚本归入“汇总本地三次计时结果”阶段，动作是“运行分析脚本/系统检查”类保守文案；卡片不展示 heredoc，不声称定位根因，不生成未来计划。

### RPC-04 MCP 业务语义

先向同一群发送一条独立种子消息 `<marker>-seed`，确认 lark-cli 已能读取该消息后，再发送测试 prompt；搜索目标固定为完整种子 marker，避免搜索索引里没有正样本。

完整 prompt：

> E2E `<marker>`。必须实际调用一次 `search_chat` 搜索完整字符串 `<marker>-seed`，不得用 shell、文件搜索或口头假装搜索。完成后返回匹配数量。

通过标准：结构化日志出现真实 MCP 工具调用；卡片显示“搜索聊天记录”或等价业务动作；不出现裸 `mcp_tool_call`；结果更新原步骤且不新增结果行。

### RPC-05 Codex 同卡 started/completed

完整 prompt：

> E2E `<marker>`。必须依次执行三个独立 command_execution，不得合并：1）`sed -n '1p' /tmp/nanoclaw-readable-progress-fixture/input.txt`；2）`rg -n 'readable-progress-needle' /tmp/nanoclaw-readable-progress-fixture/input.txt`；3）`node --test /tmp/nanoclaw-readable-progress-fixture/fixture.test.mjs`。不得替换测试命令。完成后返回 marker。

通过标准：日志中第三个命令的 started/completed 使用相同 `toolCallId`；10 秒窗口内保存 running 卡，结束后保存 terminal 卡；两份快照 message ID 相同、测试步骤数不增加、标题 running→completed；Claude/Codex 的读取、搜索、测试用户语义一致。

### RPC-06 Codex 失败终态

完整 prompt：

> E2E `<marker>`。必须实际执行且只执行一个命令 `sh -c 'echo <marker> >&2; exit 7'`，不得改写退出码、不得重试。随后如实说明失败。

通过标准：Codex completed 事件 exit code 为 7；原步骤更新为失败而非完成；最终回复正常送达；过程记录保留有界错误依据；默认卡不显示命令正文。

## 证据审计 RPC-AUDIT-01

复用 RPC-01、RPC-05、RPC-06 的卡片和过程记录，统计并报告：默认卡 raw command、绝对路径、内部 ID、裸 MCP 名和重复结果行均为 0；过程记录均有调用依据；普通日志没有完整参数和结果正文。此项是横向审计，不计为第 7 条 Real E2E。

## 协议探针

以下必须随报告提供测试名和 PASS 输出，但不计 Real E2E：

1. print `user/tool_result`、SDK 空内容 `is_error`、Codex `cancelled/canceled/interrupted` 映射。
2. 工具步骤滑出三行窗口后仍更新过程记录。
3. turn 结束缺 completion 时持久化“结果未知”。
4. 畸形 structured progress 使用安全 fallback。
5. `NANOCLAW_READABLE_PROGRESS=0` 回退旧展示。
6. 限流重试复用 `mainOnOutput`，序列化结果含 progress。
7. synthetic canary 覆盖 Bearer、API key、带凭据 URL、query token 和私钥，runner 输出与过程记录均不含原值。

## 通过门槛

- RPC-01 至 RPC-06 全部通过，缺任何一份要求的 raw card 快照即失败。
- RPC-AUDIT-01 的五类泄露/重复计数全部为 0。
- 协议探针全部通过，并与 Real E2E 分栏汇报。
- 证据交 C2 复核，C2 明确 GO 后才能向用户汇报完成。
