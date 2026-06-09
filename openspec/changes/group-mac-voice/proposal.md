## Why

现有语音通知只对主会话默认生效，并通过 Pushover 推到手机；用户实际需要的是每个群独立开关，开启的群才把最终结果摘要推到手机/耳机朗读。多群协同时，播报还必须带群别名，否则听不出是哪一个群的结果。

## What Changes

- 增加按群独立配置的 Pushover 语音播报开关，默认关闭。
- 复用现有语音摘要能力，把最终回复压缩成适合 TTS 的口语总结。
- 播报内容前追加群标识，优先使用已配置的群别名，缺失时回退群名或短 JID。
- 移除主群默认播报语义，主群也必须显式开启 `/voice on` 才推送。
- 兼容早期 `voiceNotify.mac` 配置，把它视为已开启推送，命令保存时迁移为 `voiceNotify.push`。

## Capabilities

### New Capabilities

- `group-mac-voice`: 按群控制 Pushover 语音播报、摘要生成和别名前缀。

### Modified Capabilities

无。

## Impact

- `src/types.ts`: 扩展 `ContainerConfig` 的语音播报配置。
- `src/voice-notify.ts`: 拆分摘要、Pushover sink 和播报策略。
- `src/channels/feishu.ts`: 最终回复时传入群上下文，按配置触发播报。
- `src/commands/`: 新增或扩展群级命令，允许当前群开启、关闭、查看语音推送状态。
- `src/db.ts` / `src/group-alias.ts`: 读取已有别名映射用于播报前缀，不改变表结构。
- 测试覆盖群配置、别名回退、命令持久化、主群不默认播报和旧 `mac` 配置兼容。
