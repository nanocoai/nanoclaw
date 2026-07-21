/**
 * Matrix channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Supports two auth methods (resolved by the adapter from env):
 *   - Access token: MATRIX_ACCESS_TOKEN + MATRIX_USER_ID
 *   - Password:     MATRIX_USERNAME + MATRIX_PASSWORD (+ optional MATRIX_USER_ID)
 *
 * Optional env vars:
 *   MATRIX_BOT_USERNAME         — display name for the bot (default: "bot")
 *   MATRIX_INVITE_AUTOJOIN      — "true" to auto-accept room invites
 *   MATRIX_INVITE_AUTOJOIN_ALLOWLIST — comma-separated user IDs allowed to invite
 *   MATRIX_RECOVERY_KEY         — enable E2EE cross-signing
 *   MATRIX_DEVICE_ID            — stable device ID across restarts
 */
import { createMatrixAdapter } from '@beeper/chat-adapter-matrix';

import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Assumes a dedicated bot account on a homeserver (the common install).
 * Non-threaded at the bridge level, so group engagement is 'mention', never
 * sticky. Personal-account installs should edit their copy to dm 'strict' —
 * install-wide changes live in this declaration by design.
 */
const MATRIX_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

const ENV_KEYS = [
  'MATRIX_BASE_URL',
  'MATRIX_ACCESS_TOKEN',
  'MATRIX_USERNAME',
  'MATRIX_PASSWORD',
  'MATRIX_USER_ID',
  'MATRIX_BOT_USERNAME',
  'MATRIX_DEVICE_ID',
  'MATRIX_RECOVERY_KEY',
  'MATRIX_INVITE_AUTOJOIN',
  'MATRIX_INVITE_AUTOJOIN_ALLOWLIST',
] as const;

/**
 * Wrap the Matrix adapter so DM conversations are identified by user handle
 * across the whole system, not by ephemeral room IDs.
 *
 * Matrix DMs live in rooms (e.g. "!abc:server"), but NanoClaw identifies
 * channels by platform_id. Using a user handle as platform_id means both
 * the user and the messaging group reference the same stable identifier.
 *
 * Two directions to bridge:
 *   - Outbound: delivery passes "matrix:@user:server" → resolve to room via openDM
 *   - Inbound: adapter emits "matrix:!room:server" → rewrite to user handle
 *     so the router finds the existing messaging group instead of creating
 *     a new one.
 *
 * Both resolutions are cached for the process lifetime.
 */
function wrapWithDmResolution(adapter: ReturnType<typeof createMatrixAdapter>): typeof adapter {
  const origPostMessage = adapter.postMessage.bind(adapter);
  const origStartTyping = adapter.startTyping.bind(adapter);
  const origChannelIdFromThreadId = adapter.channelIdFromThreadId.bind(adapter);

  // roomId → user handle, used to rewrite inbound channel IDs.
  const roomToUserCache = new Map<string, string>();

  function isUserHandle(threadId: string): boolean {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      return !roomID.startsWith('!');
    } catch {
      return true;
    }
  }

  async function resolveThreadId(threadId: string): Promise<string> {
    if (!isUserHandle(threadId)) return threadId;

    const userHandle = threadId.startsWith('matrix:') ? threadId.slice('matrix:'.length) : threadId;
    log.info('Matrix: resolving DM room for user handle', { userHandle });
    const resolved = await adapter.openDM(userHandle);

    try {
      const { roomID } = adapter.decodeThreadId(resolved);
      roomToUserCache.set(roomID, userHandle);
    } catch {
      // decode failure is non-fatal — outbound still works
    }

    return resolved;
  }

  // Rewrite inbound room-based channel IDs to user-handle form for DM rooms.
  // Non-DM rooms pass through unchanged.
  adapter.channelIdFromThreadId = (threadId: string): string => {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      if (!roomID.startsWith('!')) return origChannelIdFromThreadId(threadId);

      const cached = roomToUserCache.get(roomID);
      if (cached) return `matrix:${cached}`;

      // Not cached — check if this is a DM by membership count
      const client = (adapter as any).client;
      const room = client?.getRoom(roomID);
      if (!room) return origChannelIdFromThreadId(threadId);
      if (room.getJoinedMemberCount() > 2) return origChannelIdFromThreadId(threadId);

      const botId = (adapter as any).userID;
      const otherMember = room.getJoinedMembers().find((m: { userId: string }) => m.userId !== botId);
      if (!otherMember) return origChannelIdFromThreadId(threadId);

      roomToUserCache.set(roomID, otherMember.userId);
      return `matrix:${otherMember.userId}`;
    } catch {
      return origChannelIdFromThreadId(threadId);
    }
  };

  // The Chat SDK calls adapter.isDM(threadId) synchronously to decide whether
  // to dispatch to onDirectMessage handlers. The Matrix adapter doesn't expose
  // this method — it only has an async isDirectRoom(). We add a synchronous
  // isDM that checks room membership count: 2 members = DM.
  (adapter as any).isDM = (threadId: string): boolean => {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      const client = (adapter as any).client;
      if (!client) return false;
      const room = client.getRoom(roomID);
      if (!room) return false;
      const members = room.getJoinedMemberCount();
      return members <= 2;
    } catch {
      return false;
    }
  };

  adapter.postMessage = async (
    threadId: string,
    ...args: Parameters<typeof origPostMessage> extends [string, ...infer R] ? R : never
  ) => {
    const resolvedTid = await resolveThreadId(threadId);
    return origPostMessage(resolvedTid, ...args);
  };

  adapter.startTyping = async (threadId: string) => {
    const resolvedTid = await resolveThreadId(threadId);
    return origStartTyping(resolvedTid);
  };

  return adapter;
}

registerChannelAdapter('matrix', {
  factory: () => {
    const env = readEnvFile([...ENV_KEYS]);
    if (!env.MATRIX_BASE_URL) return null;
    if (!env.MATRIX_ACCESS_TOKEN && !(env.MATRIX_USERNAME && env.MATRIX_PASSWORD)) return null;

    for (const key of ENV_KEYS) {
      if (env[key]) process.env[key] = env[key];
    }

    // Default: auto-join room invites so DMs work without manual acceptance
    if (!process.env.MATRIX_INVITE_AUTOJOIN) {
      process.env.MATRIX_INVITE_AUTOJOIN = 'true';
    }

    const matrixAdapter = wrapWithDmResolution(createMatrixAdapter());
    const bridge = createChatSdkBridge({
      adapter: matrixAdapter,
      concurrency: 'concurrent',
      supportsThreads: false,
      defaults: MATRIX_DEFAULTS,
    });

    // Matrix user IDs contain ":" (e.g. "@user:matrix.org") which the shared
    // permissions module interprets as already-prefixed. Wrap onInbound to
    // ensure senderId always carries the "matrix:" channel prefix so user
    // records match between init-first-agent and inbound routing.
    const origSetup = bridge.setup.bind(bridge);
    bridge.setup = async (hostConfig) => {
      const origOnInbound = hostConfig.onInbound.bind(hostConfig);
      await origSetup({
        ...hostConfig,
        onInbound: (platformId, threadId, message) => {
          if (message.content && typeof message.content === 'object') {
            const content = message.content as Record<string, unknown>;
            if (typeof content.senderId === 'string' && !content.senderId.startsWith('matrix:')) {
              content.senderId = `matrix:${content.senderId}`;
            }
          }
          return origOnInbound(platformId, threadId, message);
        },
      });

      // Wait for Matrix sync to reach PREPARED state before returning from setup.
      // Without this, the host's delivery poll and sweep timer start immediately
      // and can starve the SDK's sync generator microtask queue, blocking
      // incremental syncs so new inbound messages never get dispatched.
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if ((matrixAdapter as unknown as { liveSyncReady?: boolean }).liveSyncReady) {
            log.info('Matrix sync ready');
            clearInterval(check);
            resolve();
          }
        }, 500);
        setTimeout(() => {
          clearInterval(check);
          resolve();
        }, 30_000);
      });
    };

    return bridge;
  },
  defaults: MATRIX_DEFAULTS,
});
