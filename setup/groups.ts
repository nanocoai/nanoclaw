/**
 * Step: groups — Fetch group metadata from messaging platforms, write to DB.
 * WhatsApp requires an upfront sync (Baileys groupFetchAllParticipating).
 * Other channels discover group names at runtime — this step auto-skips for them.
 * Replaces 05-sync-groups.sh + 05b-list-groups.sh
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { log } from '../src/log.js';
import { emitStatus } from './status.js';

function parseArgs(args: string[]): { list: boolean; limit: number } {
  let list = false;
  let limit = 30;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list') list = true;
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    }
  }
  return { list, limit };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { list, limit } = parseArgs(args);

  if (list) {
    await listGroups(limit);
    return;
  }

  await syncGroups(projectRoot);
}

async function listGroups(limit: number): Promise<void> {
  const dbPath = path.join(STORE_DIR, 'messages.db');

  if (!fs.existsSync(dbPath)) {
    console.error('ERROR: database not found');
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      `SELECT jid, name FROM chats
     WHERE jid LIKE '%@g.us' AND jid <> '__group_sync__' AND name <> jid
     ORDER BY last_message_time DESC
     LIMIT ?`,
    )
    .all(limit) as Array<{ jid: string; name: string }>;
  db.close();

  for (const row of rows) {
    console.log(`${row.jid}|${row.name}`);
  }
}

async function syncGroups(projectRoot: string): Promise<void> {
  // Only WhatsApp needs an upfront group sync; other channels resolve names at runtime.
  // Detect WhatsApp by checking for auth credentials on disk.
  const authDir = path.join(projectRoot, 'store', 'auth');
  const hasWhatsAppAuth =
    fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;

  if (!hasWhatsAppAuth) {
    log.info('WhatsApp auth not found — skipping group sync');
    emitStatus('SYNC_GROUPS', {
      BUILD: 'skipped',
      SYNC: 'skipped',
      GROUPS_IN_DB: 0,
      REASON: 'whatsapp_not_configured',
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
    return;
  }

  // Build TypeScript first
  log.info('Building TypeScript');
  let buildOk = false;
  try {
    execSync('pnpm run build', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    buildOk = true;
    log.info('Build succeeded');
  } catch {
    log.error('Build failed');
    emitStatus('SYNC_GROUPS', {
      BUILD: 'failed',
      SYNC: 'skipped',
      GROUPS_IN_DB: 0,
      STATUS: 'failed',
      ERROR: 'build_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // Run sync script via a temp file to avoid shell escaping issues with node -e
  log.info('Fetching group metadata');
  let syncOk = false;
  try {
    const syncScript = `
import makeWASocket, { useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

const logger = pino({ level: 'silent' });
const authDir = path.join('store', 'auth');
const dbPath = path.join('store', 'messages.db');

if (!fs.existsSync(authDir)) {
  console.error('NO_AUTH');
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT)');

const upsert = db.prepare(
  'INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?) ON CONFLICT(jid) DO UPDATE SET name = excluded.name'
);

const { state, saveCreds } = await useMultiFileAuthState(authDir);

const sock = makeWASocket({
  auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
  printQRInTerminal: false,
  logger,
  browser: Browsers.macOS('Chrome'),
});

const timeout = setTimeout(() => {
  console.error('TIMEOUT');
  process.exit(1);
}, 30000);

sock.ev.on('creds.update', saveCreds);

sock.ev.on('connection.update', async (update) => {
  if (update.connection === 'open') {
    try {
      const groups = await sock.groupFetchAllParticipating();
      const now = new Date().toISOString();
      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          upsert.run(jid, metadata.subject, now);
          count++;
        }
      }
      console.log('SYNCED:' + count);
    } catch (err) {
      console.error('FETCH_ERROR:' + err.message);
    } finally {
      clearTimeout(timeout);
      sock.end(undefined);
      db.close();
      process.exit(0);
    }
  } else if (update.connection === 'close') {
    clearTimeout(timeout);
    console.error('CONNECTION_CLOSED');
    process.exit(1);
  }
});
`;

    const tmpScript = path.join(projectRoot, '.tmp-group-sync.mjs');
    fs.writeFileSync(tmpScript, syncScript, 'utf-8');
    try {
      const output = execSync(`node ${tmpScript}`, {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 45000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      syncOk = output.includes('SYNCED:');
      log.info('Sync output', { output: output.trim() });
    } finally {
      try { fs.unlinkSync(tmpScript); } catch { /* ignore cleanup errors */ }
    }
  } catch (err) {
    log.error('Sync failed', { err });
  }

  // Count groups in DB using better-sqlite3 (no sqlite3 CLI)
  let groupsInDb = 0;
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare(
          "SELECT COUNT(*) as count FROM chats WHERE jid LIKE '%@g.us' AND jid <> '__group_sync__'",
        )
        .get() as { count: number };
      groupsInDb = row.count;
      db.close();
    } catch {
      // DB may not exist yet
    }
  }

  const status = syncOk ? 'success' : 'failed';

  emitStatus('SYNC_GROUPS', {
    BUILD: buildOk ? 'success' : 'failed',
    SYNC: syncOk ? 'success' : 'failed',
    GROUPS_IN_DB: groupsInDb,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
