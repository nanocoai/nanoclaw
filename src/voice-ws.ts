/**
 * 语音播报 WebSocket 出口：向自研 iOS app 实时广播语音摘要。
 *
 * - 仅当 .env 配置 VOICE_WS_TOKEN 时启动（无鉴权不裸奔端口）
 * - 连接 URL 必须带 ?token=，错 token 立即 close(4001)
 * - 30s 心跳 ping，上一轮没 pong 的连接 terminate
 * - 一切异常打 warn 吃掉，绝不影响飞书主流程
 */
import { WebSocket, WebSocketServer } from 'ws';

import { logger } from './logger.js';
import { readEnvFile } from './env.js';

const DEFAULT_PORT = 8790;
const HEARTBEAT_INTERVAL_MS = 30_000;

export interface VoiceSpeakMessage {
  type: 'speak';
  label: string;
  text: string;
  ts: number;
}

let wss: WebSocketServer | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
const aliveClients = new WeakSet<WebSocket>();

function resolveConfig(): { token: string | null; port: number } {
  // token 从 .env 文件读，fallback process.env（主进程不把 .env 注入 process.env）
  const envFile = readEnvFile(['VOICE_WS_TOKEN', 'VOICE_WS_PORT']);
  const token = envFile.VOICE_WS_TOKEN || process.env.VOICE_WS_TOKEN || null;
  const portRaw = envFile.VOICE_WS_PORT || process.env.VOICE_WS_PORT;
  const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
  return { token, port: Number.isFinite(port) ? port : DEFAULT_PORT };
}

export function startVoiceWsServer(): void {
  if (wss) return;
  const { token, port } = resolveConfig();
  if (!token) {
    logger.warn(
      '[voice-ws] 缺 VOICE_WS_TOKEN，语音 WS 服务不启动（配置 .env 后重启生效）',
    );
    return;
  }

  try {
    wss = new WebSocketServer({ port, host: '0.0.0.0' });
  } catch (err) {
    logger.warn({ err, port }, '[voice-ws] 服务启动失败');
    wss = null;
    return;
  }

  wss.on('error', (err) => {
    logger.warn({ err }, '[voice-ws] 服务异常');
  });

  wss.on('listening', () => {
    logger.info({ port }, '[voice-ws] 语音 WS 服务已启动');
  });

  wss.on('connection', (ws, req) => {
    let clientToken: string | null = null;
    try {
      const url = new URL(req.url ?? '/', 'ws://localhost');
      clientToken = url.searchParams.get('token');
    } catch {
      clientToken = null;
    }
    if (clientToken !== token) {
      logger.warn(
        { remote: req.socket?.remoteAddress },
        '[voice-ws] token 不匹配，拒绝连接',
      );
      ws.close(4001, 'unauthorized');
      return;
    }

    aliveClients.add(ws);
    ws.on('pong', () => aliveClients.add(ws));
    ws.on('error', (err) => {
      logger.warn({ err }, '[voice-ws] 客户端连接异常');
    });
    ws.on('close', () => {
      logger.info(
        { remote: req.socket?.remoteAddress },
        '[voice-ws] 客户端断开',
      );
    });
    logger.info(
      { remote: req.socket?.remoteAddress },
      '[voice-ws] 客户端已连接',
    );
  });

  heartbeatTimer = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      if (!aliveClients.has(ws)) {
        ws.terminate();
        continue;
      }
      aliveClients.delete(ws);
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  // 不阻止进程退出
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
}

/**
 * 广播一条语音播报。无服务/无客户端时静默跳过。
 */
export function broadcastVoiceSpeech(label: string, text: string): void {
  if (!wss) return;
  const payload: VoiceSpeakMessage = {
    type: 'speak',
    label,
    text,
    ts: Date.now(),
  };
  const data = JSON.stringify(payload);
  let sent = 0;
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    try {
      ws.send(data);
      sent++;
    } catch (err) {
      logger.warn({ err }, '[voice-ws] 广播发送失败');
    }
  }
  if (sent > 0) {
    logger.info({ sent, chars: text.length }, '[voice-ws] 已广播语音播报');
  }
}

export function stopVoiceWsServer(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (wss) {
    try {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    } catch (err) {
      logger.warn({ err }, '[voice-ws] 关闭异常');
    }
    wss = null;
  }
}
