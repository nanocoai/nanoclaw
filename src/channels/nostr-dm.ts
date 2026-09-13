import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { connect } from 'net';

import WebSocket from 'ws';
import { useWebSocketImplementation, SimplePool } from 'nostr-tools/pool';

import { GROUPS_DIR, NOSTR_DM_ALLOWLIST, NOSTR_DM_RELAYS, NOSTR_SIGNER_SOCKET } from '../config.js';
import { reportError, clearAlert } from '../health.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelRegistration, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

interface NostrEvent {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
  sig: string;
}

interface Rumor {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
}

function daemonRequest(payload: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = connect(NOSTR_SIGNER_SOCKET);
    let data = '';
    sock.on('connect', () => {
      sock.write(JSON.stringify(payload));
      sock.end();
    });
    sock.on('data', (chunk) => {
      data += chunk;
    });
    sock.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error(`Bad response from signer: ${data}`));
      }
    });
    sock.on('error', (err) => {
      sock.destroy();
      reject(new Error(`Cannot connect to signing daemon at ${NOSTR_SIGNER_SOCKET}: ${err.message}`));
    });
  });
}

function getTag(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

function createNostrDMAdapter(): ChannelAdapter | null {
  if (NOSTR_DM_ALLOWLIST.size === 0) return null;

  let config: ChannelSetup;
  let pool: SimplePool | null = null;
  let connected = false;
  let ownPubkey = '';
  let outgoingQueue: Array<{ platformId: string; text: string }> = [];
  const MAX_OUTGOING_QUEUE = 100;
  let seenIds = new Set<string>();
  // NIP-17 gift wrap timestamps are fuzzed ±48h for privacy.
  // A DM sent right now may have created_at hours in the past.
  // Use a 72h lookback + seenIds dedup to catch all recent DMs.
  let lastEventTimestamp = Math.floor(Date.now() / 1000) - 72 * 3600;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let subCloser: { close: () => void } | null = null;
  let profileCache = new Map<string, { name: string; fetchedAt: number }>();
  let profileFetching = new Set<string>();

  function subscribe(): void {
    if (!pool) return;
    subCloser = pool.subscribeMany(
      NOSTR_DM_RELAYS,
      { kinds: [1059], '#p': [ownPubkey], since: lastEventTimestamp },
      {
        onevent: (event: NostrEvent) => {
          handleGiftWrap(event).catch((err) => log.error('Error handling Nostr gift wrap', { err }));
        },
        onclose: (reasons: string[]) => {
          log.warn('Nostr DM relay subscriptions closed', { reasons });
          connected = false;
          scheduleReconnect();
        },
      },
    );
  }

  async function handleGiftWrap(event: NostrEvent): Promise<void> {
    if (seenIds.has(event.id)) return;
    seenIds.add(event.id);
    if (event.created_at > lastEventTimestamp) {
      lastEventTimestamp = event.created_at;
    }
    if (seenIds.size > 10000) {
      const arr = [...seenIds];
      seenIds = new Set(arr.slice(-5000));
    }

    let rumor: Rumor;
    try {
      const res = await daemonRequest({ method: 'unwrap_gift_wrap', params: { event } });
      if (res.error) {
        log.warn('Failed to unwrap gift wrap', { error: res.error });
        return;
      }
      rumor = res.rumor as Rumor;
    } catch (err) {
      log.warn('Daemon unwrap request failed', { err });
      return;
    }

    if (rumor.kind !== 14 && rumor.kind !== 15) return;
    const senderPubkey = rumor.pubkey;
    if (senderPubkey === ownPubkey) return;
    if (!NOSTR_DM_ALLOWLIST.has(senderPubkey)) {
      log.debug('Nostr DM from non-allowlisted pubkey, ignoring', { sender: senderPubkey.slice(0, 12) });
      return;
    }

    const platformId = senderPubkey;
    const timestamp = new Date().toISOString();
    const senderName = await resolveDisplayName(senderPubkey);

    let content = rumor.content || '';

    if (rumor.kind === 15) {
      const fileType = getTag(rumor.tags, 'file-type');
      if (!fileType?.startsWith('image/')) {
        content = content || '[File attachment - unsupported type]';
      } else {
        const imagePath = await downloadAndDecryptAttachment(rumor, platformId);
        content = imagePath ? `[Image: ${imagePath}]` : '[Image - download/decrypt failed]';
      }
    }

    if (!content) return;

    config.onMetadata(platformId, senderName, false);

    const inbound: InboundMessage = {
      id: rumor.id,
      kind: 'chat',
      content: {
        text: content,
        sender: senderPubkey,
        senderId: `nostr:${senderPubkey}`,
        senderName,
      },
      timestamp,
    };
    void config.onInbound(platformId, null, inbound);
  }

  async function resolveDisplayName(pubkey: string): Promise<string> {
    const fallback = pubkey.slice(0, 12);
    const cached = profileCache.get(pubkey);
    if (cached && Date.now() - cached.fetchedAt < 86400000) return cached.name;
    if (!pool || profileFetching.has(pubkey)) return cached?.name || fallback;
    profileFetching.add(pubkey);
    try {
      const event = await pool.get(NOSTR_DM_RELAYS, { kinds: [0], authors: [pubkey] }, { maxWait: 5000 });
      if (event?.content) {
        const meta = JSON.parse(event.content);
        const name = meta.display_name || meta.displayName || meta.name || fallback;
        profileCache.set(pubkey, { name, fetchedAt: Date.now() });
        return name;
      }
    } catch (err) {
      log.debug('Failed to fetch Nostr profile', { err, pubkey: fallback });
    } finally {
      profileFetching.delete(pubkey);
    }
    profileCache.set(pubkey, { name: fallback, fetchedAt: Date.now() });
    return fallback;
  }

  async function downloadAndDecryptAttachment(rumor: Rumor, platformId: string): Promise<string | null> {
    const url = rumor.content?.trim();
    const keyHex = getTag(rumor.tags, 'decryption-key');
    const nonceHex = getTag(rumor.tags, 'decryption-nonce');
    const algo = getTag(rumor.tags, 'encryption-algorithm');
    const fileType = getTag(rumor.tags, 'file-type') || 'image/jpeg';
    const fileHash = getTag(rumor.tags, 'x') || rumor.id;

    if (!url || !keyHex || !nonceHex) {
      log.warn('Missing fields for Nostr file attachment', { url: !!url, key: !!keyHex, nonce: !!nonceHex });
      return null;
    }

    // Find group folder from conversations
    const conv = config.conversations.find((c) => c.platformId === platformId);
    if (!conv) {
      log.warn('No registered conversation for Nostr DM attachment', { platformId });
      return null;
    }

    // Derive folder from agentGroupId — in V2 the folder is in the agent_groups table
    // For now, use a generic attachments dir under the agent group folder
    const ext = fileType.split('/')[1]?.split(';')[0] || 'bin';
    const attachDir = path.join(GROUPS_DIR, 'nostr-attachments');
    fs.mkdirSync(attachDir, { recursive: true });
    const filePath = path.join(attachDir, `${fileHash}.${ext}`);

    if (fs.existsSync(filePath)) return `/workspace/group/attachments/${fileHash}.${ext}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        log.warn('Failed to download Nostr attachment', { url, status: res.status });
        return null;
      }
      const encrypted = Buffer.from(await res.arrayBuffer());

      if (algo !== 'aes-gcm') {
        log.warn('Unsupported encryption algorithm', { algo });
        return null;
      }

      const key = Buffer.from(keyHex, 'hex');
      const nonce = Buffer.from(nonceHex, 'hex');
      const authTag = encrypted.subarray(encrypted.length - 16);
      const ciphertext = encrypted.subarray(0, encrypted.length - 16);

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      fs.writeFileSync(filePath, decrypted);
      log.info('Nostr DM image decrypted and saved', { hash: fileHash, size: decrypted.length });
      return `/workspace/group/attachments/${fileHash}.${ext}`;
    } catch (err) {
      log.warn('Failed to download/decrypt Nostr attachment', { err, url });
      return null;
    }
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return;
    reconnectAttempts++;
    if (reconnectAttempts === 3) {
      reportError(
        'nostr-dm-disconnect',
        `Nostr DM relay connections lost. Failed to reconnect ${reconnectAttempts} times.`,
      );
    }
    const delay = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 60000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      log.info('Reconnecting Nostr DM relays...');
      try {
        subCloser?.close();
        pool?.close(NOSTR_DM_RELAYS);
        pool = new SimplePool();
        subscribe();
        connected = true;
        reconnectAttempts = 0;
        clearAlert('nostr-dm-disconnect');
        flushOutgoingQueue().catch((err) => log.error('Failed to flush Nostr DM outgoing queue', { err }));
      } catch (err) {
        log.error('Nostr DM reconnect failed', { err });
        scheduleReconnect();
      }
    }, delay);
  }

  async function flushOutgoingQueue(): Promise<void> {
    while (outgoingQueue.length > 0) {
      const item = outgoingQueue.shift()!;
      try {
        const res = await daemonRequest({
          method: 'wrap_dm',
          params: { recipientPubkey: item.platformId, message: item.text },
        });
        if (res.error) throw new Error(res.error as string);
        const events = res.events as NostrEvent[];
        await Promise.all(events.map((ev) => pool!.publish(NOSTR_DM_RELAYS, ev)));
      } catch (err) {
        log.error('Failed to flush Nostr DM queued message', { err, platformId: item.platformId });
      }
    }
  }

  const adapter: ChannelAdapter = {
    name: 'NostrDM',
    channelType: 'nostr-dm',
    supportsThreads: false,

    async setup(cfg: ChannelSetup): Promise<void> {
      config = cfg;
      const res = await daemonRequest({ method: 'get_public_key' });
      if (res.error) throw new Error(`Signer error: ${res.error}`);
      ownPubkey = res.pubkey as string;

      useWebSocketImplementation(WebSocket);
      pool = new SimplePool();
      subscribe();

      connected = true;
      reconnectAttempts = 0;
      clearAlert('nostr-dm-disconnect');
      log.info('Nostr DM channel connected', {
        pubkey: ownPubkey,
        relays: NOSTR_DM_RELAYS.length,
        allowlist: NOSTR_DM_ALLOWLIST.size,
      });

      flushOutgoingQueue().catch((err) => log.error('Failed to flush Nostr DM outgoing queue', { err }));
    },

    async teardown(): Promise<void> {
      connected = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      subCloser?.close();
      pool?.close(NOSTR_DM_RELAYS);
      pool = null;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const content = message.content as Record<string, unknown> | string | undefined;
      let text: string | undefined;
      if (typeof content === 'string') text = content;
      else if (content && typeof content.text === 'string') text = content.text;
      if (!text) return undefined;

      if (!connected || !pool) {
        if (outgoingQueue.length >= MAX_OUTGOING_QUEUE) {
          log.error('Nostr DM outgoing queue full, dropping oldest message', {
            platformId,
            queueSize: outgoingQueue.length,
          });
          outgoingQueue.shift();
        }
        outgoingQueue.push({ platformId, text });
        log.info('Nostr DM channel disconnected, message queued', { platformId, queueSize: outgoingQueue.length });
        return undefined;
      }

      try {
        const res = await daemonRequest({ method: 'wrap_dm', params: { recipientPubkey: platformId, message: text } });
        if (res.error) throw new Error(res.error as string);
        const events = res.events as NostrEvent[];
        await Promise.all(events.map((ev) => pool!.publish(NOSTR_DM_RELAYS, ev)));
        log.info('Nostr DM sent', { platformId, textLen: text.length, wraps: events.length });
        return events[0]?.id;
      } catch (err) {
        outgoingQueue.push({ platformId, text });
        log.warn('Failed to send Nostr DM, queued', { platformId, err, queueSize: outgoingQueue.length });
        return undefined;
      }
    },
  };

  return adapter;
}

const registration: ChannelRegistration = {
  factory: createNostrDMAdapter,
  containerConfig: {
    mounts: [{ hostPath: NOSTR_SIGNER_SOCKET, containerPath: '/run/nostr/signer.sock', readonly: false }],
  },
};

registerChannelAdapter('nostr-dm', registration);
