/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createRequire } from 'node:module';

import type { DiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Dedicated bot app on a threaded platform. group threads:true matches the
 * declared supportsThreads (the skill-installed install-style knob) so
 * mention-sticky engagement stays bounded per-thread. dm.threads:false —
 * DM replies land top-level, one session per DM.
 */
const DISCORD_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

/**
 * Discord message forwards carry their content in `message_snapshots`, not
 * `content` (`message_reference.type === 1` means FORWARD; 0 is a normal
 * reply). The adapter only reads `content`/`attachments`, so without this the
 * agent sees an empty message. Unwrap the snapshot back into the payload so
 * text, attachment download, and formatting all ride the existing path.
 * Note: snapshots contain no author, so the original sender is unavailable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapForwardedSnapshot(data: Record<string, any>): void {
  if (data.message_reference?.type !== 1) return;
  const snaps = (data.message_snapshots ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((s: any) => s?.message)
    .filter(Boolean);
  if (snaps.length === 0) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = snaps
    .map((m: any) => m.content)
    .filter(Boolean)
    .join('\n');
  const label = '[Forwarded message]';
  data.content = text ? `${label}\n${text}` : data.content || label;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fwdAttachments = snaps.flatMap((m: any) => m.attachments ?? []);
  if (fwdAttachments.length > 0) {
    data.attachments = [...(data.attachments ?? []), ...fwdAttachments];
  }
}

function unwrapForwards(adapter: DiscordAdapter): void {
  const a = adapter as unknown as {
    handleForwardedMessage: (data: Record<string, unknown>, options?: unknown) => Promise<void>;
  };
  const orig = a.handleForwardedMessage.bind(adapter);
  a.handleForwardedMessage = async (data, options) => {
    unwrapForwardedSnapshot(data);
    return orig(data, options);
  };
}

/**
 * True when Node routes its own HTTP clients through HTTP(S)_PROXY
 * (`NODE_USE_ENV_PROXY=1` or `--use-env-proxy`) and a proxy is configured.
 */
export function isEnvProxyActive(env: NodeJS.ProcessEnv = process.env, execArgv: string[] = process.execArgv): boolean {
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!proxy) return false;
  return (
    env.NODE_USE_ENV_PROXY === '1' ||
    execArgv.includes('--use-env-proxy') ||
    (env.NODE_OPTIONS ?? '').split(/\s+/).includes('--use-env-proxy')
  );
}

interface WsModule {
  WebSocket: unknown;
}

/**
 * Run `load` with `ws.WebSocket` pointing at the native WebSocket, then put
 * the original back. @discordjs/ws captures `require('ws').WebSocket` once at
 * module load, so the Gateway keeps the native constructor while every other
 * `ws` consumer (Slack Socket Mode included) still sees the real package.
 */
export function withNativeWebSocket(ws: WsModule, native: unknown, load: () => void): void {
  const original = ws.WebSocket;
  ws.WebSocket = native;
  try {
    load();
  } finally {
    ws.WebSocket = original;
  }
}

/** Resolve the `ws` copy @discordjs/ws uses, and a loader for @discordjs/ws itself. */
export function resolveGatewayModules(): { ws: WsModule; loadGateway: () => void } {
  const fromAdapter = createRequire(import.meta.resolve('@chat-adapter/discord'));
  const fromDiscordJs = createRequire(fromAdapter.resolve('discord.js'));
  const gatewayPath = fromDiscordJs.resolve('@discordjs/ws');
  const ws = createRequire(gatewayPath)('ws') as WsModule;
  return { ws, loadGateway: () => fromDiscordJs(gatewayPath) };
}

/**
 * The `ws` package dials TLS itself and ignores Node's env proxy, so behind
 * an HTTPS proxy the Gateway connection fails while REST (fetch) works.
 * Native WebSocket honors the env proxy; hand it to @discordjs/ws before
 * discord.js loads.
 */
function routeGatewayThroughEnvProxy(): void {
  if (!isEnvProxyActive() || typeof globalThis.WebSocket !== 'function') return;
  const { ws, loadGateway } = resolveGatewayModules();
  withNativeWebSocket(ws, globalThis.WebSocket, loadGateway);
}

async function createDiscordBridge(env: Record<string, string | undefined>, botToken: string) {
  routeGatewayThroughEnvProxy();
  const { createDiscordAdapter } = await import('@chat-adapter/discord');
  const discordAdapter = createDiscordAdapter({
    botToken,
    publicKey: env.DISCORD_PUBLIC_KEY,
    applicationId: env.DISCORD_APPLICATION_ID,
  });
  unwrapForwards(discordAdapter);
  return createChatSdkBridge({
    adapter: discordAdapter,
    concurrency: 'concurrent',
    botToken,
    extractReplyContext,
    supportsThreads: true,
    defaults: DISCORD_DEFAULTS,
    // Discord rejects messages over 2000 chars; without this the bridge
    // would let long agent replies fail instead of splitting them.
    maxTextLength: 2000,
  });
}

registerChannelAdapter('discord', {
  factory: () => {
    const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID']);
    if (!env.DISCORD_BOT_TOKEN) return null;
    return createDiscordBridge(env, env.DISCORD_BOT_TOKEN);
  },
  defaults: DISCORD_DEFAULTS,
});
