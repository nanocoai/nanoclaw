/**
 * 语音回传订阅：以 client 角色连公网语音网关 WS，
 * 接收 iOS app（大狗播报）的语音回复 {type:'reply', group_id, text}，
 * 注入对应群会话（storeMessage + enqueueMessageCheck）并回显到飞书。
 *
 * 链路：iOS 语音识别 → 网关 /ws/ios 上行 reply → 网关广播给 /ws/client
 *      → 本模块 → 注入群消息（等同大杰发了一条文字）→ 飞书回显「🎤 大杰（语音）」
 *
 * 设计原则：
 * - 用 Node 22 内置 WebSocket（undici，支持自定义 header 鉴权），不依赖 ws 包
 * - 断线指数退避重连（1s 起，上限 60s），连上即归零
 * - group_id 不匹配已注册群 → 丢弃并记日志（spec 要求，防误注入）
 * - 失败不影响主流程：缺 token 只 warn 跳过
 */
import { logger } from './logger.js';
import { readEnvFile } from './env.js';

const VOICE_GATEWAY_WS_URL =
  process.env.VOICE_GATEWAY_WS_URL || 'wss://api.saltapp.cn/voice/ws/client';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

export interface VoiceReplyDeps {
  /** 判断 group_id 是否为已注册群 JID */
  isRegisteredGroup: (jid: string) => boolean;
  /** 注入群会话：storeMessage + enqueueMessageCheck */
  injectMessage: (jid: string, text: string) => void;
  /** 回显到飞书群，让聊天记录里能看到这条语音转写 */
  echoToFeishu: (jid: string, text: string) => Promise<void>;
}

/** 飞书回显文案（spec：🎤 大杰（语音）） */
export function buildEchoText(text: string): string {
  return `🎤 大杰（语音）：${text}`;
}

/**
 * 处理网关下发的一条 WS 消息。导出供单测。
 * 返回值仅用于测试断言：处理结果分类。
 */
export function handleGatewayMessage(
  raw: string,
  deps: VoiceReplyDeps,
): 'ignored' | 'dropped' | 'injected' {
  let msg: {
    type?: string;
    group_id?: string | null;
    group_name?: string | null;
    text?: string;
  };
  try {
    msg = JSON.parse(raw);
  } catch {
    return 'ignored';
  }
  if (msg.type !== 'reply') return 'ignored';

  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (!text) return 'ignored';

  const groupId = typeof msg.group_id === 'string' ? msg.group_id : null;
  if (!groupId || !deps.isRegisteredGroup(groupId)) {
    // spec：group_id 缺失或不匹配 → 丢弃记日志，不能误注入别的群
    logger.warn(
      { groupId, groupName: msg.group_name ?? null, chars: text.length },
      '[voice-reply] reply 的 group_id 不是已注册群，丢弃',
    );
    return 'dropped';
  }

  logger.info(
    { groupId, chars: text.length },
    '[voice-reply] 收到语音回复，注入群会话',
  );
  deps.injectMessage(groupId, text);
  // 回显失败不影响注入（消息已进会话）
  void deps.echoToFeishu(groupId, buildEchoText(text)).catch((err) => {
    logger.warn({ err, groupId }, '[voice-reply] 飞书回显失败');
  });
  return 'injected';
}

/**
 * 启动订阅：建立 WS 连接并自动重连。fire-and-forget，失败不抛。
 */
export function startVoiceReplySubscriber(deps: VoiceReplyDeps): void {
  // token 优先 .env 文件，fallback process.env（同 voice-notify，launchd 环境坑）
  const envFile = readEnvFile(['VOICE_GATEWAY_TOKEN']);
  const token = envFile.VOICE_GATEWAY_TOKEN || process.env.VOICE_GATEWAY_TOKEN;
  if (!token) {
    logger.warn(
      { hasToken: false },
      '[voice-reply] 缺 VOICE_GATEWAY_TOKEN，语音回传订阅不启动（检查 .env）',
    );
    return;
  }

  let attempt = 0;

  const connect = (): void => {
    let ws: WebSocket;
    try {
      // Node 22 内置 WebSocket（undici）支持第二参数 headers（已对线上网关实测通过）
      ws = new WebSocket(VOICE_GATEWAY_WS_URL, {
        headers: { 'X-Voice-Token': token },
      } as unknown as string[]);
    } catch (err) {
      logger.warn({ err }, '[voice-reply] WebSocket 构造失败');
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      attempt = 0;
      logger.info(
        { url: VOICE_GATEWAY_WS_URL },
        '[voice-reply] 语音网关订阅已连接',
      );
    });

    ws.addEventListener('message', (event) => {
      try {
        const raw =
          typeof event.data === 'string' ? event.data : String(event.data);
        handleGatewayMessage(raw, deps);
      } catch (err) {
        logger.warn({ err }, '[voice-reply] 处理网关消息异常');
      }
    });

    ws.addEventListener('error', () => {
      // close 事件随后必触发，统一在 close 里重连；这里吃掉避免 unhandled
    });

    ws.addEventListener('close', (event) => {
      logger.warn(
        { code: event.code, reason: event.reason },
        '[voice-reply] 语音网关连接断开，准备重连',
      );
      scheduleReconnect();
    });
  };

  const scheduleReconnect = (): void => {
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** attempt,
      RECONNECT_MAX_MS,
    );
    attempt += 1;
    setTimeout(connect, delay).unref();
  };

  connect();
}
