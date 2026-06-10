## Why

现有语音播报走 Pushover + iOS 系统"朗读通知"，但系统朗读不可控：消息折叠后不播、多条并发不按队列播。用户将自研 iOS app 接管播报（本地 TTS 队列），NanoClaw 需要一个实时推送出口把语音摘要送到 app。

## What Changes

- 新增内置 WebSocket 服务（`ws` 库，已有于 node_modules），向已连接的 app 客户端广播语音播报消息。
- 触发条件复用现有群级 `/voice` 开关（`voiceNotify.push`），摘要复用现有 LLM 口语化摘要。
- 广播与 Pushover 推送并行存在，互不影响（双出口）。
- 连接需 token 鉴权（`.env` 的 `VOICE_WS_TOKEN`）；未配置 token 时服务不启动，杜绝裸奔端口。
- 心跳清理死连接；服务异常不影响主流程。

## Capabilities

### New Capabilities

- `voice-ws-stream`: 内置 WebSocket 服务，向自研 iOS app 实时广播带群标识的语音摘要。

### Modified Capabilities

无（`group-mac-voice` 行为不变，仅在其摘要产物上增加一个出口）。

## Impact

- `src/voice-ws.ts`: 新增，WS 服务（启动/鉴权/广播/心跳/关闭）。
- `src/voice-notify.ts`: 摘要完成后追加 WS 广播。
- `src/index.ts`: 主进程启动/关闭 WS 服务。
- `src/types/ws.d.ts`: `ws` 库最小类型声明（无 @types/ws，禁止 npm install）。
- `package.json`: 声明 `ws` 依赖（已存在于 node_modules，仅补声明）。
