## Context

现有语音通知入口在 `src/channels/feishu.ts` 的最终回复路径，调用 `notifyVoice(groupFolder, textForSpeech)`。`src/voice-notify.ts` 当前把 `groupFolder === 'feishu_main'` 作为唯一触发条件，先用 DashScope 兼容接口提炼口语摘要，再推送 Pushover 给手机朗读。群配置已经通过 `RegisteredGroup.containerConfig` 持久化，群别名已经存在于 `group_aliases` 表并被 `/alias` 与跨群派工复用。

## Goals / Non-Goals

**Goals:**

- 每个群可独立开关 Mac 本地播报，默认关闭。
- 复用现有摘要 prompt，播报最终结果的短总结，不播工具进度。
- 播报前缀带群别名，别名缺失时回退群名或短 JID。
- Mac 本地播报串行执行，避免多群同时发声。
- 不破坏主群 Pushover 链路。

**Non-Goals:**

- 不做跨机器播报协议；本期只支持 NanoClaw 运行所在 Mac 的本地 `say`。
- 不自动切换音频设备；用户自己把 Mac 输出切到耳机或 AirPods。
- 不把所有群默认开启；必须显式开启。
- 不把 toolcall/progress 也播出来。

## Decisions

1. **配置放在 `RegisteredGroup.containerConfig.voiceNotify`**
   - 方案：扩展 `ContainerConfig`，例如 `{ voiceNotify: { mac: true } }`。
   - 理由：已有 `/brief`、`/quiet`、`/mode` 都用 containerConfig 持久化群级行为，复用这条路径最小。
   - 替代方案：新增 SQLite 表。当前配置简单，没有必要加迁移和查询复杂度。

2. **摘要与出口拆分**
   - 方案：把 `voice-notify.ts` 拆成 `summarizeForSpeech()`、`pushToPushover()`、`speakOnMac()`、`notifyVoice(context)`。
   - 理由：摘要逻辑复用，Pushover 和 Mac 只是不同 sink。
   - 替代方案：新建完全独立的 Mac 模块。会复制摘要 prompt 和过滤规则，后续难维护。

3. **别名前缀由 host 拼接，不交给 LLM 猜**
   - 方案：Feishu channel 传入 `chatJid/groupFolder/groupName`，voice-notify 查询或接收 alias 后拼接 `{label}：{summary}`。
   - 理由：群名是确定元数据，不应该消耗 LLM token，也不能让 LLM 编错。
   - 替代方案：把群名放进摘要 prompt。可控性差。

4. **Mac 播报使用 `/usr/bin/say` 串行队列**
   - 方案：用 `spawn('/usr/bin/say', ['-v', voice, text])`，队列一次只跑一个进程。
   - 理由：macOS 原生能力，无新增依赖，能跟随当前音频输出设备。
   - 替代方案：调用云 TTS 生成音频后 `afplay`。质量可控但复杂、慢，还要管理文件。

5. **触发点仍在最终回复路径**
   - 方案：只在 `sendMessage()` 正式回复处触发；progress 和 toolcard 不触发。
   - 理由：用户要听“结果”，不是听执行流水账。

## Risks / Trade-offs

- [Risk] `say` 在非 macOS 或非用户 GUI session 下不可用 → Mitigation: 检测平台和命令失败，仅 warn，不影响飞书回复。
- [Risk] 多群连续播报过多打扰用户 → Mitigation: 默认关闭，显式按群开启；队列串行；后续可加冷却或只保留最新。
- [Risk] 摘要 LLM 慢导致播报延迟 → Mitigation: 保持现有 15s 摘要超时和原文截断 fallback。
- [Risk] 别名表是 alias→jid，不是 jid→alias → Mitigation: 提供纯函数从 `getAllGroupAliases()` 反查第一个匹配 alias，并测试别名优先级。

## Migration Plan

1. 新增配置字段和 `/voice` 命令，默认所有群关闭。
2. 重构 `voice-notify.ts`，保持主群 Pushover 旧行为。
3. Feishu 最终回复路径传入群上下文并触发 Mac sink。
4. 单测覆盖后 build，重启 NanoClaw 生效。
5. 回滚时关闭群配置或回退本次提交即可，不涉及 DB schema。

## Open Questions

- 是否需要为主群同时开启 Pushover 和 Mac 双播？本期设计允许，但默认只保持旧 Pushover。
- 是否需要 `/voice test` 立即播一句测试音？建议作为 P1，P0 先做 on/off/status。

## 测试计划

**P0 纯函数测试：**

- `shouldNotifyMacVoice()`：默认关闭、开启、短文本、媒体占位、非最终路径。
- `resolveVoiceGroupLabel()`：alias 优先、群名回退、短 JID 回退。
- `buildSpokenText()`：前缀拼接和长度限制。

**P0 mock 测试：**

- `/voice on/off/status` 修改并持久化当前群配置。
- Mac voice queue 串行调用 mock `spawn`，失败后继续处理下一条。
- Feishu 最终回复在群开启时调用 voice-notify，关闭时不调用。

**P1 兼容测试：**

- 主群 Pushover 旧路径仍触发。
- 非主群 Mac 播报不要求 Pushover token。

预估新增或修改 12-16 个单测，覆盖 `voice-notify.ts`、`commands/voice.ts`、`channels/feishu.test.ts`。
