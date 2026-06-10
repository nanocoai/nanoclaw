# voice-ws-stream 设计

## 链路

```
最终回复 → notifyVoice（群开了 /voice）
            ├─ LLM 口语摘要（复用，qwen-turbo，15s 超时）
            ├─ Pushover 推送（保留，兜底）
            └─ WS 广播 {type:'speak', label, text, ts} → iOS app 本地 TTS 队列
```

## 服务（src/voice-ws.ts）

- `startVoiceWsServer()`：主进程启动时调用。
  - token 从 `readEnvFile(['VOICE_WS_TOKEN'])` 读（.env 不注入 process.env，前车之鉴），fallback `process.env`。
  - **缺 token → 不启动**，warn 一条。没有降级、没有无鉴权模式。
  - 端口 `VOICE_WS_PORT`（默认 8790），监听 `0.0.0.0`（手机要从局域网/Tailscale 连进来）。
- 鉴权：连接 URL `?token=xxx`，不匹配立即 `close(4001)`。
- 心跳：服务端每 30s `ping`，上一轮没回 `pong` 的连接 terminate。
- `broadcastVoiceSpeech(label, text)`：对所有 OPEN 客户端 send JSON；无客户端时静默返回。
- `stopVoiceWsServer()`：shutdown 时关闭。
- 所有异常吃掉打 warn，绝不影响主流程。

## 消息协议

```json
{ "type": "speak", "label": "一号群", "text": "测试跑通了……", "ts": 1760000000000 }
```

app 端按到达顺序入队播报；协议字段后续可加 priority。

## 类型声明

无 @types/ws 且禁止 npm install → `src/types/ws.d.ts` 手写最小声明：
`WebSocketServer`（构造/`on('connection')`/`clients`/`close`）、`WebSocket`（`send`/`on`/`ping`/`terminate`/`readyState`/`OPEN`）。

## 安全

- token 必须配置才启动；token 只比对不打日志。
- 监听端口暴露在局域网——pf 防火墙规则需放行（部署时核对，不在本 change 内改 pf）。

## 不做的事

- 不做离线消息缓存/补播（app 不在线就丢，MVP 接受；Pushover 仍是兜底通道）。
- 不做多用户/多 token。
