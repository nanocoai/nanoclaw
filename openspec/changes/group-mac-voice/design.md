## Context

现有语音通知入口在 `src/channels/feishu.ts` 的最终回复路径，调用 `notifyVoice(groupFolder, textForSpeech)`。`src/voice-notify.ts` 当前把 `groupFolder === 'feishu_main'` 作为默认触发条件，先用 DashScope 兼容接口提炼口语摘要，再推送 Pushover 给手机朗读。实际需求调整为每个群独立开关，开启的群才推送；主群也不再默认推送。群配置已经通过 `RegisteredGroup.containerConfig` 持久化，群别名已经存在于 `group_aliases` 表并被 `/alias` 与跨群派工复用。

## Goals / Non-Goals

**Goals:**

- 每个群可独立开关 Pushover 语音推送，默认关闭。
- 复用现有摘要 prompt，播报最终结果的短总结，不播工具进度。
- 播报前缀带群别名，别名缺失时回退群名或短 JID。
- 主群取消默认播报，也走同一个显式开关。
- 兼容早期 `voiceNotify.mac` 配置，避免短期配置丢失。

**Non-Goals:**

- 不把所有群默认开启；必须显式开启。
- 不把 toolcall/progress 也播出来。
- 不新增新的客户端 listener；继续复用 Pushover/iOS 朗读通知。

## Decisions

1. **配置放在 `RegisteredGroup.containerConfig.voiceNotify`**
   - 方案：扩展 `ContainerConfig`，例如 `{ voiceNotify: { push: true } }`。
   - 理由：已有 `/brief`、`/quiet`、`/mode` 都用 containerConfig 持久化群级行为，复用这条路径最小。
   - 替代方案：新增 SQLite 表。当前配置简单，没有必要加迁移和查询复杂度。

2. **摘要与出口拆分**
   - 方案：把 `voice-notify.ts` 拆成 `summarizeForSpeech()`、`pushToPushover()`、`notifyVoice(context)`。
   - 理由：摘要逻辑复用，触发策略与推送出口分离，后续能再接别的 sink。
   - 替代方案：沿用 `groupFolder === 'feishu_main'`。无法满足按群开关。

3. **别名前缀由 host 拼接，不交给 LLM 猜**
   - 方案：Feishu channel 传入 `chatJid/groupFolder/groupName`，voice-notify 查询或接收 alias 后拼接 `{label}：{summary}`。
   - 理由：群名是确定元数据，不应该消耗 LLM token，也不能让 LLM 编错。
   - 替代方案：把群名放进摘要 prompt。可控性差。

4. **主群默认播报取消**
   - 方案：`shouldNotifyPushover()` 只看 `voiceNotify.push === true`，兼容 `voiceNotify.mac === true`。
   - 理由：用户要求所有群统一靠开关控制，主群不再有特殊默认行为。
   - 替代方案：主群默认继续播、其他群按开关。语义不统一，容易误报。

5. **触发点仍在最终回复路径**
   - 方案：只在 `sendMessage()` 正式回复处触发；progress 和 toolcard 不触发。
   - 理由：用户要听“结果”，不是听执行流水账。

## Risks / Trade-offs

- [Risk] 多群连续播报过多打扰用户 → Mitigation: 默认关闭，显式按群开启；队列串行；后续可加冷却或只保留最新。
- [Risk] 摘要 LLM 慢导致播报延迟 → Mitigation: 保持现有 15s 摘要超时和原文截断 fallback。
- [Risk] 别名表是 alias→jid，不是 jid→alias → Mitigation: 提供纯函数从 `getAllGroupAliases()` 反查第一个匹配 alias，并测试别名优先级。
- [Risk] 旧 `mac` 配置已经写入少量群 → Mitigation: 运行时兼容 `mac`，命令保存时迁移为 `push`。

## Migration Plan

1. 新增配置字段和 `/voice` 命令，默认所有群关闭。
2. 重构 `voice-notify.ts`，取消主群默认触发，改为显式群开关触发 Pushover。
3. Feishu 最终回复路径传入群上下文并触发 Pushover sink。
4. 单测覆盖后 build，重启 NanoClaw 生效。
5. 回滚时关闭群配置或回退本次提交即可，不涉及 DB schema。

## Open Questions

- 是否需要 `/voice test` 立即播一句测试音？建议作为 P1，P0 先做 on/off/status。

## 测试计划

**P0 纯函数测试：**

- `shouldNotifyPushover()`：默认关闭、开启、短文本、媒体占位、非最终路径、旧 `mac` 兼容。
- `resolveVoiceGroupLabel()`：alias 优先、群名回退、短 JID 回退。
- `buildSpokenText()`：前缀拼接和长度限制。

**P0 mock 测试：**

- `/voice on/off/status` 修改并持久化当前群配置。
- Feishu 最终回复在群开启时调用 voice-notify，关闭时不调用。

**P1 兼容测试：**

- 主群未开启时不默认触发。
- Pushover token 缺失时 warn 且不影响飞书回复。

预估新增或修改 12-16 个单测，覆盖 `voice-notify.ts`、`commands/voice.ts`、`channels/feishu.test.ts`。
