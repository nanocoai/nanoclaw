import fs from 'fs';
import net from 'net';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { DATA_DIR, TIMEZONE } from '../src/config.js';
import { readEnvFile } from '../src/env.js';

const SOCKET_PATH = path.join(DATA_DIR, 'cli.sock');
const STATE_PATH = path.join(DATA_DIR, 'cody-wake-watcher.json');

const TICK_MS = 15_000;
const WAKE_GAP_MS = 90_000;
const NOTIFY_COOLDOWN_MS = 120_000;
const STARTUP_COOLDOWN_MS = 5 * 60_000;
const REMOTE_SYNC_MS = 30_000;
const MAX_REMOTE_FILE_CHARS = 120_000;

const execFileAsync = promisify(execFile);

type WatcherState = {
  lastNotifiedAt?: string;
  lastEvent?: string;
  lastStartupAt?: string;
  deliveredRemoteCodyIds?: string[];
};

type RemoteCodyMessage = {
  id: string;
  timestamp: string;
  text: string;
  files: Array<{
    name: string;
    content: string;
    truncated: boolean;
  }>;
};

function readState(): WatcherState {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as WatcherState;
  } catch {
    return {};
  }
}

function writeState(state: WatcherState): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function formatNow(): string {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date());
}

function minutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

async function waitForSocket(timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(SOCKET_PATH)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return fs.existsSync(SOCKET_PATH);
}

async function sendToCody(
  text: string,
  sender: { name: string; id: string } = { name: 'MacBook System', id: 'system:macbook-wake-watcher' },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(SOCKET_PATH);
    const payload = {
      text,
      sender: sender.name,
      senderId: sender.id,
      to: {
        channelType: 'telegram_cody',
        platformId: 'telegram:7914645494',
        threadId: 'telegram:7914645494',
      },
    };

    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(JSON.stringify(payload) + '\n', (err) => {
        if (err) {
          reject(err);
          return;
        }
        setTimeout(() => socket.end(), 100);
      });
    });
    socket.once('close', () => resolve());
  });
}

function getBridgeEnv(): { sshTarget?: string; projectRoot: string; roniAgentId: string } {
  const env = readEnvFile(['SERVER_RONI_SSH_TARGET', 'SERVER_RONI_PROJECT_ROOT', 'SERVER_RONI_AGENT_ID']);
  return {
    sshTarget: env.SERVER_RONI_SSH_TARGET,
    projectRoot: env.SERVER_RONI_PROJECT_ROOT || '/opt/nanoclaw',
    roniAgentId: env.SERVER_RONI_AGENT_ID || 'ag-1779753187257-7xmvcg',
  };
}

async function fetchRemoteCodyMessages(): Promise<RemoteCodyMessage[]> {
  const { sshTarget, projectRoot, roniAgentId } = getBridgeEnv();
  if (!sshTarget) return [];

  const remoteScript = `
    const Database = (await import('better-sqlite3')).default;
    const fs = await import('fs');
    const path = await import('path');
    const root = process.cwd();
    const central = new Database(path.join(root, 'data', 'v2.db'), { readonly: true });
    const session = central
      .prepare("SELECT id, agent_group_id FROM sessions WHERE agent_group_id = ? AND status = 'active' ORDER BY last_active DESC, created_at DESC LIMIT 1")
      .get(${JSON.stringify(roniAgentId)});
    central.close();
    if (!session) {
      console.log('[]');
    } else {
      const outboundPath = path.join(root, 'data', 'v2-sessions', session.agent_group_id, session.id, 'outbound.db');
      const db = new Database(outboundPath, { readonly: true });
      const rows = db
        .prepare("SELECT id, timestamp, content FROM messages_out WHERE channel_type = 'remote_cody' ORDER BY seq ASC LIMIT 100")
        .all();
      db.close();
      const messages = rows.map((row) => {
        let parsed = {};
        try { parsed = JSON.parse(row.content); } catch {}
        const fileNames = Array.isArray(parsed.files) ? parsed.files.filter((x) => typeof x === 'string') : [];
        const files = fileNames.map((name) => {
          const safeName = path.basename(name);
          const filePath = path.join(root, 'data', 'v2-sessions', session.agent_group_id, session.id, 'outbox', row.id, safeName);
          if (!fs.existsSync(filePath)) return null;
          const full = fs.readFileSync(filePath, 'utf8');
          return {
            name: safeName,
            content: full.slice(0, ${MAX_REMOTE_FILE_CHARS}),
            truncated: full.length > ${MAX_REMOTE_FILE_CHARS},
          };
        }).filter(Boolean);
        return {
          id: row.id,
          timestamp: row.timestamp,
          text: typeof parsed.text === 'string' ? parsed.text : row.content,
          files,
        };
      });
      console.log(JSON.stringify(messages));
    }
  `;

  const encodedScript = Buffer.from(remoteScript, 'utf8').toString('base64');
  const { stdout } = await execFileAsync(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=8',
      sshTarget,
      `cd ${JSON.stringify(projectRoot)} && printf %s ${JSON.stringify(encodedScript)} | base64 -d | node --input-type=module -`,
    ],
    { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
  );
  return JSON.parse(stdout || '[]') as RemoteCodyMessage[];
}

function formatRemoteCodyMessage(message: RemoteCodyMessage): string {
  const parts = [`Roni가 보낸 메시지입니다.`, '', message.text.trim()];
  for (const file of message.files) {
    parts.push('', `첨부 파일: ${file.name}`, '```markdown', file.content.trim(), '```');
    if (file.truncated) parts.push('(파일이 길어 앞부분만 전달됐습니다.)');
  }
  parts.push('', `원격 메시지 ID: ${message.id}`, `시간: ${message.timestamp}`);
  return parts.join('\n');
}

let remoteSyncRunning = false;

async function syncRemoteCodyOutbox(): Promise<void> {
  if (remoteSyncRunning) return;
  remoteSyncRunning = true;
  try {
    const state = readState();
    const delivered = new Set(state.deliveredRemoteCodyIds || []);
    const messages = await fetchRemoteCodyMessages();
    const fresh = messages.filter((message) => !delivered.has(message.id));

    for (const message of fresh) {
      await sendToCody(formatRemoteCodyMessage(message), {
        name: 'Roni',
        id: 'telegram_cody:7914645494',
      });
      delivered.add(message.id);
      writeState({
        ...readState(),
        deliveredRemoteCodyIds: Array.from(delivered).slice(-200),
      });
      console.log(`[${new Date().toISOString()}] delivered remote Roni message to Cody: ${message.id}`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] remote Cody sync failed:`, err);
  } finally {
    remoteSyncRunning = false;
  }
}

async function notify(event: 'startup' | 'wake', text: string, cooldownMs = NOTIFY_COOLDOWN_MS): Promise<void> {
  const state = readState();
  const lastNotifiedAt = state.lastNotifiedAt ? Date.parse(state.lastNotifiedAt) : 0;
  if (lastNotifiedAt && Date.now() - lastNotifiedAt < cooldownMs) {
    console.log(`[${new Date().toISOString()}] skipped ${event}; cooldown active`);
    return;
  }

  const socketReady = await waitForSocket(60_000);
  if (!socketReady) {
    console.error(`[${new Date().toISOString()}] skipped ${event}; NanoClaw CLI socket not found at ${SOCKET_PATH}`);
    return;
  }

  await sendToCody(text);
  const notifiedAt = new Date().toISOString();
  writeState({
    ...state,
    lastEvent: event,
    lastNotifiedAt: notifiedAt,
    ...(event === 'startup' ? { lastStartupAt: notifiedAt } : {}),
  });
  console.log(`[${notifiedAt}] notified Cody: ${event}`);
}

void notify(
  'startup',
  `시스템 알림: 로컬 Cody wake watcher가 시작됐습니다. Cody는 MacBook 또는 로컬 NanoClaw가 다시 시작된 것으로 인지하면 됩니다. 현재 시각: ${formatNow()}`,
  STARTUP_COOLDOWN_MS,
).catch((err) => console.error(`[${new Date().toISOString()}] startup notify failed:`, err));

let lastTick = Date.now();

setInterval(() => {
  const now = Date.now();
  const gap = now - lastTick;
  lastTick = now;

  if (gap < WAKE_GAP_MS) return;

  void notify(
    'wake',
    `시스템 알림: MacBook이 잠자기 또는 정지 상태에서 깨어난 것으로 감지됐습니다. 멈춰 있던 시간은 약 ${minutes(gap)}분입니다. 현재 시각: ${formatNow()}`,
  ).catch((err) => console.error(`[${new Date().toISOString()}] wake notify failed:`, err));
}, TICK_MS);

void syncRemoteCodyOutbox();
setInterval(() => {
  void syncRemoteCodyOutbox();
}, REMOTE_SYNC_MS);

process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));
