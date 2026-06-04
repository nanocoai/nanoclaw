## 0. 前置验证

- [ ] 0.1 手动验证 `claude --resume <id>` 在交互模式（不带 --print）下的行为
- [ ] 0.2 手动验证 tmux send-keys -l 能否正确注入文本并触发 Claude 响应

## 1. 配置与类型

- [ ] 1.1 修改 ContainerConfig: `useCliMode` 改为 `cliMode: 'sdk' | 'print' | 'interactive'`，保持向后兼容（`useCliMode: true` → `cliMode: 'print'`）
- [ ] 1.2 修改 ContainerInput 对应字段
- [ ] 1.3 修改 agent-runner/index.ts 的模式分叉逻辑（三分支）

## 2. SSE 解析器（纯函数，零依赖）

- [ ] 2.1 实现 `sse-parser.ts`: `parseSseLine()`, `parseSseEvent()`, `SseAccumulator` 类
- [ ] 2.2 实现 `mapSseToContainerOutput()` — SSE 事件 → ContainerOutput 映射
- [ ] 2.3 SSE 解析器单元测试（P0，纯函数，~20 用例）

## 3. Tap Proxy（MITM 代理 + SSE 拦截）

- [ ] 3.1 实现 `tap-proxy.ts`: HTTPS CONNECT 隧道、TLS 终止、上游转发
- [ ] 3.2 实现 SSE 响应流拦截：检测 api.anthropic.com/v1/messages、逐行解析 SSE、EventEmitter 推送
- [ ] 3.3 实现 CA 证书自动生成（启动时生成 CA、按需生成服务器证书）
- [ ] 3.4 实现 session 路由（按 proxy auth token 区分）
- [ ] 3.5 实现 upstream token 热更新（账号轮换）
- [ ] 3.6 Tap Proxy 单元测试（P1，mock socket，~10 用例）

## 4. tmux 会话管理

- [ ] 4.1 实现 `tmux-session-manager.ts`: 纯函数 `buildTmuxSessionName()`, `escapeTmuxInput()`, `buildTmuxCommand()`
- [ ] 4.2 实现 session 创建/复用/销毁生命周期
- [ ] 4.3 实现消息注入（短消息 send-keys / 长消息 load-buffer）
- [ ] 4.4 实现健康检查（tmux session + claude 进程 + MCP server）
- [ ] 4.5 实现孤儿 session 清理
- [ ] 4.6 tmux 纯函数单元测试（P0，~10 用例）

## 5. 交互式 CLI Runner（整合）

- [ ] 5.1 实现 `interactive-cli-runner.ts`: `runInteractiveQuery()` 入口
- [ ] 5.2 整合 tmux 输入 + Tap Proxy SSE 输出
- [ ] 5.3 实现超时控制（10 分钟）
- [ ] 5.4 实现 session 恢复（--resume fallback）
- [ ] 5.5 实现 usage 累积（多轮 tool_use）
- [ ] 5.6 Runner 单元测试（P1，mock tmux + tap，~10 用例）

## 6. 宿主侧集成

- [ ] 6.1 修改 `container-runner.ts`: 启动 Tap Proxy、构建环境变量链、合并 CA 证书
- [ ] 6.2 修改 `agent-runner/index.ts`: interactive 模式分支调用 `runInteractiveQuery()`
- [ ] 6.3 现有测试适配（cli-runner.test.ts、account-rotate.test.ts）

## 7. 端到端验证

- [ ] 7.1 本地单群测试：发消息 → tmux 注入 → Claude 响应 → SSE 拦截 → ContainerOutput
- [ ] 7.2 多 session 并发测试
- [ ] 7.3 session 恢复测试（kill tmux → 自动重建）
