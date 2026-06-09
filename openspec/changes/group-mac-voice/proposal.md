## Why

现有语音通知只对主会话生效，并通过 Pushover 推到手机；用户戴 Mac 耳机工作时，无法直接听到其他群的结果摘要。多群协同时，播报还必须带群别名，否则听不出是哪一个群的结果。

## What Changes

- 增加按群独立配置的 Mac 本地语音播报开关，默认关闭。
- 复用现有语音摘要能力，把最终回复压缩成适合 TTS 的口语总结。
- 播报内容前追加群标识，优先使用已配置的群别名，缺失时回退群名或短 JID。
- 增加本机串行播报队列，避免多个群同时回复时语音重叠。
- 保留现有主群 Pushover 链路，不把 Pushover 改成全群默认能力。

## Capabilities

### New Capabilities

- `group-mac-voice`: 按群控制 Mac 本地语音播报、摘要生成、别名前缀和串行播放。

### Modified Capabilities

无。

## Impact

- `src/types.ts`: 扩展 `ContainerConfig` 的语音播报配置。
- `src/voice-notify.ts`: 拆分摘要、Pushover sink、Mac TTS sink 和播报策略。
- `src/channels/feishu.ts`: 最终回复时传入群上下文，按配置触发播报。
- `src/commands/`: 新增或扩展群级命令，允许当前群开启、关闭、查看 Mac 播报状态。
- `src/db.ts` / `src/group-alias.ts`: 读取已有别名映射用于播报前缀，不改变表结构。
- 测试覆盖群配置、别名回退、播报队列、命令持久化和旧 Pushover 兼容。
