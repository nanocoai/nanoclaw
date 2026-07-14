## 1. 卡片构建与状态

- [x] 1.1 提取可供 create/patch 复用的最终正文卡构建函数，保持字号、Markdown 与 usage footer 一致
- [x] 1.2 为 progress entry 增加 `start-only | text-only | progress` 状态、文字候选与独立发送标记，并让空步骤进度卡只渲染动态标题
- [x] 1.3 增加不创建空 session 的独立起手卡 create 路径，同时保留已有缓冲合并行为

## 2. 首请求生命周期

- [x] 2.1 在飞书 setTyping(true) 中幂等创建起手卡，失败时清理占位且不阻断 Agent
- [x] 2.2 narration 进入 text-only，plan/工具永久进入 progress，接管过程不创建第二张卡
- [x] 2.3 实现 SDK 正式正文原卡转正，并在 main/retry 两套 onOutput 中对称调用 `tryFinalizeTextOnly`，消费 usage/thinking
- [x] 2.4 保留语音通知，防止 non-quiet narration 与 usage-only 双发
- [x] 2.5 实现媒体首响应、建卡未完成和终态 patch 失败的安全降级
- [x] 2.6 保持 progress 接管后的完成卡、正式回复、thinking-only retry 和 cleanup 现有语义

## 3. 并发与日志

- [x] 3.1 将直接转正纳入 finalized + patchLoopPromise 终态顺序，拒绝迟到 spinner/进度覆盖
- [x] 3.2 增加起手卡创建、进度接管、直接转正、失败降级与迟到拒绝的结构化日志
- [x] 3.3 确保新增日志不包含正文、媒体路径、工具参数和凭据

## 4. 定向测试

- [x] 4.1 覆盖仅标题卡、重复 setTyping 与建卡失败不阻断
- [x] 4.2 覆盖 SDK 快速纯文本、main/retry 两套 Codex text-only 同 message_id 转正、100KB 候选上限、usage footer、语音通知及 create=1/patch=1/delete=0
- [x] 4.3 覆盖 narration、plan、工具 started 接管、non-quiet 防双发及现有 Phase/工具行为不回归
- [x] 4.4 覆盖媒体首响应、patch 失败、无回复 cleanup 与迟到进度
- [x] 4.5 用可控 Promise 覆盖在途 spinner patch、建卡/最终回复竞态和 thinking-only retry，断言终态最后写且无孤儿卡
- [x] 4.6 运行飞书通道定向测试、TypeScript build 和改动文件 lint，保存完整结果

## 5. 真机验收

- [ ] 5.1 快速纯文本：确认请求后立即有起手卡，最终正文复用同一 message_id
- [ ] 5.2 首 Phase：确认原卡切换为可展开 Phase，后续动作与三阶段窗口不变
- [ ] 5.3 首工具：确认原卡显示既有动作行和结果语义，不创建第二张过程卡
- [ ] 5.4 媒体首响应：确认起手卡收口且文本、图片/文件按现有链路送达
- [ ] 5.5 读取 interactive message JSON 与结构化日志，核对 patch 次序、终态和敏感字段
