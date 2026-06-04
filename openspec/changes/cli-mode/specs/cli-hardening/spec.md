# CLI 模式鲁棒性增强

## 背景

CLI interactive 模式自上线以来连续踩了三个坑：sessionToken 截断、gzip 压缩乱码、tmux 窗口路由。根因是 CLI 模式比 SDK 多了 TapProxy + tmux 两个中间层，每层都有自己的故障模式。

目前的问题不是"能不能跑"，而是"出了问题多久能恢复"。当前答案是：要么等 30 分钟超时，要么人工介入杀进程。这不可接受。

## 历史故障清单

| 故障 | 层 | 根因 | 修复 |
|------|-----|------|------|
| SSE 拦截失效 | TapProxy | sessionToken 被冒号截断 | URL 编码 token |
| SSE 乱码 | TapProxy | gzip 压缩 + toString 截断 | 剥 Accept-Encoding + StringDecoder |
| 消息不响应 | tmux | send-keys 发错窗口 | 加 `:0` 指定 window |
| 工具解析失败 | CLI 二进制 | 模型返回格式错误 JSON | CLI 内部两步重试（不可控） |
| 上下文窗口 200k | 主进程 | CLI 模式无 modelContextWindows | 增加 model 字段二级查找 |
| tool_result 不显示 | TapProxy | SSE 流无 tool_result 事件 | 待实现：解析请求 body |

## 增强项

### P0: 消息驱动的环境健康检查 + 自恢复

**问题**：CLI 在 tmux 里崩溃、runner 卡死时，当前只能等 30 分钟超时或人工介入。

**设计原则**：不加定时器。用户发消息时才检查，检查不过就修复。没消息时不需要恢复——反正没人用。

**方案**：

在 runner 主循环的两个关键节点加检查：

**节点 1：`waitForIpcMessage` 消费 IPC 文件后、调 `runInteractiveQuery` 前**
```
收到 IPC 消息 → 检查 tmux 环境 → 不正常 → 记日志 + 尝试恢复 → 恢复成功 → 继续
                                                              → 恢复失败 → 写 error output + break 退主循环
                                → 正常 → 继续 runInteractiveQuery
```

检查内容：
1. `tmux has-session -t name` — session 是否存在
2. `tmux capture-pane -t name:0 -p` — window 0 是否有 CLI 进程（检测 `❯` 提示符）
3. TapProxy 端口是否还在监听（`net.connect` 探测）

恢复策略：
- session 不存在 → 重建 session（`getOrCreate` 已有此能力）
- CLI 挂了（window 0 无 `❯`）→ kill session + 重建
- TapProxy 挂了 → 重置单例，重新 `proxy.start()`

**节点 2：主进程 `sendMessage` 写 IPC 文件前**（可选，P1 再做）
- 检查 runner 子进程是否还活着（`process.kill(pid, 0)`）
- 死了 → 不写 IPC，直接走 `enqueueMessageCheck` 起新 runner

**文件**：`interactive-cli-runner.ts`（runner 端检查）、`group-queue.ts`（主进程端检查，P1）

### P1: tool_result 进度补全

**问题**：CLI 模式过程卡片只显示 tool_use（"🔧 Bash: xxx"），不显示执行结果。用户看不到工具输出，只能等最终回复。

**方案**：
- TapProxy `forwardViaConnectTunnel` / `forwardViaCredentialProxy` 中，当检测到 POST `/v1/messages` 请求时，解析请求 body
- 提取 `messages` 数组中 `role: 'user'` 消息的 `tool_result` content 块
- 通过 subscription 的新回调 `onToolResult?.(results)` 通知 interactive-cli-runner
- runner 构建 `progressType: 'tool_result'` 的 progress 发给主进程

**文件**：`tap-proxy.ts`、`interactive-cli-runner.ts`

### P1: tmux session 保护

**问题**：用户 attach 到 tmux session 后可能误操作（新建窗口、关闭 CLI 窗口、发送 Ctrl-C）。

**方案**：
- 创建 session 时 `set-option -t name -g status off`（隐藏状态栏，减少交互欲望）
- 给 session 加一个 hook：`set-hook -t name after-new-window "kill-window -t '#{session_name}:#{window_index}'"` — 自动杀掉新建窗口
- window 0 设 `remain-on-exit on`，CLI 崩溃时保留现场（方便调查）

**文件**：`tmux-session-manager.ts`

### P2: 优雅降级到 SDK 模式

**问题**：CLI 模式如果持续不稳定（比如 CLI 版本更新破坏了行为），整个群就瘫痪了。

**方案**：
- 群配置增加 `cliModeFallback: 'sdk'` 选项
- 当 CLI 模式连续 3 次启动失败（tmux 创建失败、TapProxy 启动失败、CLI 就绪超时），自动降级到 SDK 模式
- 降级时发一条消息通知用户："CLI 模式异常，已临时切换为 SDK 模式"
- 下次重启 runner 时尝试恢复 CLI 模式

**文件**：`container-runner.ts`、群配置

## 验收标准

1. CLI 进程在 tmux 里被 kill -9 后，**用户发下一条消息时自动恢复**（而非等 30 分钟超时）
2. runner 子进程意外退出后，主进程下次 sendMessage 时检测到并起新 runner
3. 过程卡片显示工具执行结果（`✅ 结果: xxx`）
4. 用户 attach tmux 并误操作后，不影响消息路由

## 实现顺序

P0（消息驱动健康检查 + 自恢复）→ P1（tool_result + tmux 保护 + 主进程端检查）→ P2（SDK 降级）
