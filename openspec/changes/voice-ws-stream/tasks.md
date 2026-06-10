# Tasks

## 1. WS 服务

- [ ] 1.1 `src/types/ws.d.ts` 最小类型声明
- [ ] 1.2 `src/voice-ws.ts`：start/stop/broadcast/鉴权/心跳
- [ ] 1.3 `package.json` 声明 ws 依赖（不跑 install）

## 2. 集成

- [ ] 2.1 `voice-notify.ts` 摘要后追加广播
- [ ] 2.2 `index.ts` main() 启动、shutdown 关闭

## 3. 验证

- [ ] 3.1 单测：缺 token 不启动、错 token 拒连、对 token 收到广播、多客户端、心跳踢死连接
- [ ] 3.2 npm run build 通过
- [ ] 3.3 npm test 全量通过
- [ ] 3.4 openspec validate voice-ws-stream --strict 通过
