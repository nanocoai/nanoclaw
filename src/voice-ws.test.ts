import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  broadcastVoiceSpeech,
  startVoiceWsServer,
  stopVoiceWsServer,
} from './voice-ws.js';

// 注意：不能用 Node 全局 WebSocket（undici 实现），它会读 HTTPS_PROXY 走代理，
// 连 127.0.0.1 直接失败。这里用 ws 库客户端，不走代理。
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => mockEnv),
}));

let mockEnv: Record<string, string> = {};

// 每个用例独立端口，避免串台
let portCounter = 18790 + Math.floor(Math.random() * 500);
function nextPort(): number {
  return portCounter++;
}

function connect(port: number, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}/${token ? `?token=${token}` : ''}`;
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(err));
  });
}

function waitClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.on('close', (code) => resolve(code));
  });
}

function waitMessage(ws: WebSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('message timeout')),
      timeoutMs,
    );
    ws.on('message', (data) => {
      clearTimeout(timer);
      resolve(String(data));
    });
  });
}

// startVoiceWsServer 同步返回、异步 listen，等一拍
async function startAndWait(): Promise<void> {
  startVoiceWsServer();
  await new Promise((r) => setTimeout(r, 50));
}

afterEach(() => {
  stopVoiceWsServer();
  mockEnv = {};
});

describe('voice-ws', () => {
  it('缺 VOICE_WS_TOKEN 时不启动，广播静默跳过', () => {
    mockEnv = {};
    startVoiceWsServer();
    // 不抛异常即可
    expect(() => broadcastVoiceSpeech('一号群', '测试')).not.toThrow();
  });

  it('错 token 被立即拒绝（4001）', async () => {
    const port = nextPort();
    mockEnv = { VOICE_WS_TOKEN: 'secret', VOICE_WS_PORT: String(port) };
    await startAndWait();

    const ws = await connect(port, 'wrong');
    const code = await waitClose(ws);
    expect(code).toBe(4001);
  });

  it('无 token 被立即拒绝', async () => {
    const port = nextPort();
    mockEnv = { VOICE_WS_TOKEN: 'secret', VOICE_WS_PORT: String(port) };
    await startAndWait();

    const ws = await connect(port);
    const code = await waitClose(ws);
    expect(code).toBe(4001);
  });

  it('对 token 客户端收到广播 JSON', async () => {
    const port = nextPort();
    mockEnv = { VOICE_WS_TOKEN: 'secret', VOICE_WS_PORT: String(port) };
    await startAndWait();

    const ws = await connect(port, 'secret');
    const msgPromise = waitMessage(ws);
    broadcastVoiceSpeech('一号群', '代码合完了');
    const raw = await msgPromise;
    const msg = JSON.parse(raw);
    expect(msg.type).toBe('speak');
    expect(msg.label).toBe('一号群');
    expect(msg.text).toBe('代码合完了');
    expect(typeof msg.ts).toBe('number');
    ws.close();
  });

  it('多客户端都收到广播', async () => {
    const port = nextPort();
    mockEnv = { VOICE_WS_TOKEN: 'secret', VOICE_WS_PORT: String(port) };
    await startAndWait();

    const a = await connect(port, 'secret');
    const b = await connect(port, 'secret');
    const pa = waitMessage(a);
    const pb = waitMessage(b);
    broadcastVoiceSpeech('二号群', '测试挂了');
    const [ra, rb] = await Promise.all([pa, pb]);
    expect(JSON.parse(ra).text).toBe('测试挂了');
    expect(JSON.parse(rb).text).toBe('测试挂了');
    a.close();
    b.close();
  });

  it('重复 start 幂等，stop 后可重新 start', async () => {
    const port = nextPort();
    mockEnv = { VOICE_WS_TOKEN: 'secret', VOICE_WS_PORT: String(port) };
    await startAndWait();
    startVoiceWsServer(); // 第二次应是 no-op，不抛 EADDRINUSE
    stopVoiceWsServer();

    const port2 = nextPort();
    mockEnv = { VOICE_WS_TOKEN: 'secret', VOICE_WS_PORT: String(port2) };
    await startAndWait();
    const ws = await connect(port2, 'secret');
    const p = waitMessage(ws);
    broadcastVoiceSpeech('三号群', '重启后正常');
    expect(JSON.parse(await p).text).toBe('重启后正常');
    ws.close();
  });
});
