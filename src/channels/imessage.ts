/**
 * iMessage channel adapter (v2) — uses Chat SDK bridge.
 * Supports local mode (macOS Full Disk Access) and remote mode (Photon API).
 * Self-registers on import.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import type { Attachment } from 'chat';
import { createiMessageAdapter } from 'chat-adapter-imessage';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * The operator's personal Apple ID is a shared identity — strangers DMing it
 * reach the human, not the bot, so auto-create stays 'strict'. iMessage
 * exposes no group-mention metadata ('dm-only'); group wirings default to a
 * name-pattern trigger instead ({name} = agent group name).
 */
const IMESSAGE_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'pattern', engagePattern: '\\b{name}\\b', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'dm-only',
};

const ATTACHMENTS_ROOT = path.join(os.homedir(), 'Library', 'Messages', 'Attachments');
const CHAT_DB = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const HEIC_RE = /\.hei[cf]$/i;

/**
 * Resolve the on-disk path of an inbound iMessage attachment from its
 * basename. chat.db's `attachment.filename` holds the full path (the
 * authoritative source); a bounded filesystem search is the fallback if the DB
 * can't be read. Returns null when the file can't be located.
 */
function resolveAttachmentPath(basename: string): string | null {
  try {
    const db = new Database(CHAT_DB, { readonly: true, fileMustExist: true, timeout: 3000 });
    try {
      const row = db
        .prepare('SELECT filename FROM attachment WHERE filename LIKE ? ORDER BY ROWID DESC LIMIT 1')
        .get(`%/${basename}`) as { filename?: string } | undefined;
      const raw = row?.filename;
      if (raw) {
        const resolved = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
        if (fs.existsSync(resolved)) return resolved;
      }
    } finally {
      db.close();
    }
  } catch {
    // chat.db unreadable (locked / no FDA) — fall through to filesystem search.
  }
  try {
    const hit = execFileSync('find', [ATTACHMENTS_ROOT, '-name', basename, '-type', 'f'], {
      encoding: 'utf-8',
      timeout: 8000,
    })
      .split('\n')
      .find(Boolean);
    if (hit && fs.existsSync(hit)) return hit;
  } catch {
    // find failed or timed out — give up gracefully.
  }
  return null;
}

/**
 * Read attachment bytes, converting HEIC/HEIF (the iPhone default image format,
 * which the model cannot view) to JPEG via macOS `sips`. Falls back to the raw
 * bytes if conversion fails.
 */
function readAttachmentBytes(filePath: string, isHeic: boolean): Buffer {
  if (isHeic) {
    const out = path.join(os.tmpdir(), `imsg-attach-${Date.now()}-${path.basename(filePath)}.jpg`);
    try {
      execFileSync('sips', ['-s', 'format', 'jpeg', filePath, '--out', out], {
        stdio: 'ignore',
        timeout: 20000,
      });
      const buffer = fs.readFileSync(out);
      fs.rmSync(out, { force: true });
      return buffer;
    } catch (err) {
      log.warn('iMessage HEIC→JPEG conversion failed; sending raw bytes', { filePath, err });
    }
  }
  return fs.readFileSync(filePath);
}

/**
 * Rebuild an inbound attachment downloader for iMessage local mode. The Chat
 * SDK core strips `fetchData` on serialize and the community adapter only
 * carries a basename, so the bridge would otherwise get no bytes and the agent
 * would see just a filename. The image lives on the host in the Messages
 * attachment store (readable with Full Disk Access); resolve it, converting
 * HEIC/HEIF to JPEG so the model can actually view it. Returns the attachment
 * unchanged when the file can't be found so the bridge degrades gracefully.
 */
function rehydrateiMessageAttachment(attachment: Attachment): Attachment {
  const name = typeof attachment.name === 'string' ? attachment.name : null;
  if (!name) return attachment;
  const filePath = resolveAttachmentPath(name);
  if (!filePath) {
    log.warn('iMessage attachment not found on disk', { name });
    return attachment;
  }
  const isHeic = HEIC_RE.test(name) || /hei[cf]/i.test(attachment.mimeType ?? '');
  const outName = isHeic ? (HEIC_RE.test(name) ? name.replace(HEIC_RE, '.jpg') : `${name}.jpg`) : name;
  return {
    ...attachment,
    name: outName,
    mimeType: isHeic ? 'image/jpeg' : attachment.mimeType,
    fetchData: async () => readAttachmentBytes(filePath, isHeic),
  };
}

registerChannelAdapter('imessage', {
  factory: () => {
    const env = readEnvFile(['IMESSAGE_ENABLED', 'IMESSAGE_LOCAL', 'IMESSAGE_SERVER_URL', 'IMESSAGE_API_KEY']);
    const isLocal = env.IMESSAGE_LOCAL !== 'false';
    if (isLocal && !env.IMESSAGE_ENABLED) return null;
    if (!isLocal && !env.IMESSAGE_SERVER_URL) return null;
    const rawAdapter = createiMessageAdapter({
      local: isLocal,
      serverUrl: env.IMESSAGE_SERVER_URL,
      apiKey: env.IMESSAGE_API_KEY,
    });
    // Polyfill channelIdFromThreadId (community adapter doesn't implement it).
    // In local mode, also expose rehydrateAttachment so inbound images (which
    // arrive as a bare filename) get their host-side bytes read + HEIC→JPEG
    // converted before staging into the container inbox. Remote (Photon) mode
    // has no local attachment store, so the hook is omitted there.
    const imessageAdapter = Object.assign(rawAdapter, {
      channelIdFromThreadId: (threadId: string) => threadId,
      ...(isLocal ? { rehydrateAttachment: rehydrateiMessageAttachment } : {}),
    });
    return createChatSdkBridge({
      adapter: imessageAdapter,
      concurrency: 'concurrent',
      supportsThreads: false,
      defaults: IMESSAGE_DEFAULTS,
    });
  },
  defaults: IMESSAGE_DEFAULTS,
});
