## Why

NanoClaw 当前要等第一条 Phase 或工具进度到达后才创建过程卡，模型首包延迟会让用户只看到消息 reaction；快速纯文本回复又会另发一条新消息，无法获得 Nine Standard 模式“先有反馈、原卡转正”的连续体验。现有 Phase、工具动作、串行 patch 和终态锁已经成熟，现在只需补齐首请求卡片生命周期，不应重做进度展示状态机。

## What Changes

- 飞书开始处理一次有效 Agent 请求、尚未发起模型调用时，立即创建一张只含动态标题与计时的交互卡片。
- 若首个有效 Agent 输出直接是最终纯文本，停止 spinner，并把同一张卡片原地更新为最终回复；不得另发重复文本消息。
- 若首个有效输出是 narration、plan 或工具事件，则把起手卡切换为现有进度卡，后续 Phase、动作行、三阶段窗口、过程记录与完成卡逻辑保持不变。
- 对建卡失败、建卡与最终回复竞态、迟到进度、patch 失败、媒体回复、重试与 cleanup 定义确定性的降级和终态规则。
- 增加结构化生命周期日志，能够区分起手卡创建、转入进度、原卡转正、降级发送和终态竞态。

## Capabilities

### New Capabilities

- `feishu-first-request-card`: 定义飞书首请求起手卡的创建、首输出分流、原卡转正、进度接管、失败降级与并发终态行为。

### Modified Capabilities

无。

## Impact

- 飞书通道：`src/channels/feishu.ts` 的卡片构建、`setTyping`、进度接管、正式回复和 cleanup 生命周期。
- 主循环：原则上保持 `src/index.ts` 现有 `setTyping(true) -> runAgent -> sendMessage` 顺序；仅在测试证明需要时补充观测，不改变 provider 协议。
- 测试：扩展 `src/channels/feishu.test.ts`，覆盖即时建卡、纯文本原卡转正、Phase/工具接管、媒体降级、失败和并发竞态。
- 不新增依赖，不修改 Agent runner 事件协议，不改变非飞书 Channel，不改变现有 Phase reducer、工具文案与过程记录格式。
