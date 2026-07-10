import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, GROUPS_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  DelegationStatus,
  DelegationTask,
  NewMessage,
  OAuthCredential,
  RegisteredGroup,
  ScheduledTask,
  TaskLedgerChecklistItem,
  TaskLedgerChecklistStatus,
  TaskLedgerDetail,
  TaskLedgerEvent,
  TaskLedgerStatus,
  TaskLedgerTask,
  TaskLedgerTestCase,
  TaskLedgerTestCaseStatus,
  TaskLedgerType,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS group_aliases (
      alias TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_group_aliases_chat_jid ON group_aliases(chat_jid);

    CREATE TABLE IF NOT EXISTS account_rotate_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feishu_tokens (
      user_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, chat_jid)
    );

    CREATE TABLE IF NOT EXISTS oauth_credentials (
      secret_name TEXT PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      access_token TEXT,
      expires_at INTEGER,
      cached_usage TEXT,
      last_usage_check INTEGER,
      error_state TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_chunks (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      message_ids TEXT NOT NULL DEFAULT '[]',
      chunk_text TEXT NOT NULL,
      sender_names TEXT NOT NULL DEFAULT '',
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      qdrant_indexed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_chunks_jid ON chat_chunks(chat_jid);
    CREATE INDEX IF NOT EXISTS idx_chat_chunks_group ON chat_chunks(group_folder);
    CREATE INDEX IF NOT EXISTS idx_chat_chunks_qdrant ON chat_chunks(qdrant_indexed) WHERE qdrant_indexed = 0;

    CREATE VIRTUAL TABLE IF NOT EXISTS chat_chunks_fts USING fts5(
      chunk_text,
      content='chat_chunks',
      content_rowid='rowid',
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS chat_chunks_ai AFTER INSERT ON chat_chunks BEGIN
      INSERT INTO chat_chunks_fts(rowid, chunk_text) VALUES (new.rowid, new.chunk_text);
    END;

    CREATE TABLE IF NOT EXISTS delegation_tasks (
      task_id         TEXT PRIMARY KEY,
      source_group    TEXT NOT NULL,
      source_jid      TEXT NOT NULL,
      target_group    TEXT NOT NULL,
      target_jid      TEXT NOT NULL,
      title           TEXT,
      status          TEXT NOT NULL,
      summary         TEXT,
      details         TEXT,
      artifacts       TEXT,
      dispatch_msg_id TEXT,
      dispatched_at   TEXT NOT NULL,
      last_report_at  TEXT,
      updated_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delegation_target ON delegation_tasks(target_group);
    CREATE INDEX IF NOT EXISTS idx_delegation_status ON delegation_tasks(status);
    -- DB 级兜底"一群一在办任务"：占槽态（dispatched/progress/blocked/question）下
    -- 每个 target_group 最多一条，防多进程/未来入口绕过应用层先查再插的竞态。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delegation_active_unique
      ON delegation_tasks(target_group)
      WHERE status IN ('dispatched', 'progress', 'blocked', 'question');

    CREATE TABLE IF NOT EXISTS task_ledger_tasks (
      id                  TEXT PRIMARY KEY,
      title               TEXT NOT NULL,
      project             TEXT NOT NULL,
      task_type           TEXT NOT NULL,
      status              TEXT NOT NULL,
      priority            TEXT NOT NULL DEFAULT 'normal',
      description         TEXT,
      desired_outcome     TEXT,
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      owner_group         TEXT NOT NULL,
      chat_jid            TEXT,
      created_by          TEXT,
      artifact_root       TEXT,
      prd_path            TEXT,
      spec_path           TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      completed_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_ledger_status ON task_ledger_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_task_ledger_project ON task_ledger_tasks(project);
    CREATE INDEX IF NOT EXISTS idx_task_ledger_owner ON task_ledger_tasks(owner_group);

    CREATE TABLE IF NOT EXISTS task_ledger_checklist (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL,
      title      TEXT NOT NULL,
      status     TEXT NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      notes      TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES task_ledger_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_task_ledger_checklist_task ON task_ledger_checklist(task_id, position);

    CREATE TABLE IF NOT EXISTS task_ledger_test_cases (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL,
      title       TEXT NOT NULL,
      description TEXT,
      status      TEXT NOT NULL,
      evidence    TEXT,
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES task_ledger_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_task_ledger_test_cases_task ON task_ledger_test_cases(task_id, position);

    CREATE TABLE IF NOT EXISTS task_ledger_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id      TEXT NOT NULL,
      event_type   TEXT NOT NULL,
      summary      TEXT NOT NULL,
      details      TEXT,
      actor_group  TEXT,
      actor_sender TEXT,
      created_at   TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES task_ledger_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_task_ledger_events_task ON task_ledger_events(task_id, created_at);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  migrateDelegationSourceFields(database);

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Add custom_cwd column for /cwd command
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN custom_cwd TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    const taskLedgerColumns = database
      .prepare('PRAGMA table_info(task_ledger_tasks)')
      .all() as Array<{ name: string }>;
    if (!taskLedgerColumns.some((column) => column.name === 'artifact_root')) {
      database.exec(
        `ALTER TABLE task_ledger_tasks ADD COLUMN artifact_root TEXT`,
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      'Failed to ensure task_ledger_tasks artifact_root column',
    );
  }

  // Add reply context columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
    database.exec(
      `ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`,
    );
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
  } catch {
    /* columns already exist */
  }
}

function migrateDelegationSourceFields(database: Database.Database): void {
  try {
    const delegationColumns = database
      .prepare('PRAGMA table_info(delegation_tasks)')
      .all() as Array<{ name: string }>;
    const hasSourceGroup = delegationColumns.some(
      (column) => column.name === 'source_group',
    );
    const hasSourceJid = delegationColumns.some(
      (column) => column.name === 'source_jid',
    );
    if (!hasSourceGroup) {
      database.exec(
        `ALTER TABLE delegation_tasks ADD COLUMN source_group TEXT`,
      );
    }
    if (!hasSourceJid) {
      database.exec(`ALTER TABLE delegation_tasks ADD COLUMN source_jid TEXT`);
    }

    // 每次启动都检查空 source，而不是只在刚加列时回填。
    // 如果第一次启动 ALTER 成功后在查主群/回填前失败，重启时列已存在；
    // 这里继续回填，避免旧任务留下空 source 导致权限和汇报路由读脏数据。
    const pending = database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM delegation_tasks
         WHERE source_group IS NULL OR source_group = '' OR source_jid IS NULL OR source_jid = ''`,
      )
      .get() as { count: number };
    if (pending.count === 0) return;

    const mains = database
      .prepare(`SELECT jid, folder FROM registered_groups WHERE is_main = 1`)
      .all() as Array<{ jid: string; folder: string }>;
    if (mains.length !== 1) {
      throw new Error(
        `Cannot backfill delegation source fields: expected exactly 1 main group, got ${mains.length}`,
      );
    }
    database
      .prepare(
        `UPDATE delegation_tasks
         SET source_group = COALESCE(NULLIF(source_group, ''), ?),
             source_jid = COALESCE(NULLIF(source_jid, ''), ?)
         WHERE source_group IS NULL OR source_group = '' OR source_jid IS NULL OR source_jid = ''`,
      )
      .run(mains[0].folder, mains[0].jid);
  } catch (err) {
    logger.error({ err }, 'Failed to migrate delegation_tasks source fields');
    throw err;
  }
}

export const __testing = {
  migrateDelegationSourceFields,
};

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** 获取数据库实例（供 chat-index 等模块直接查询用） */
export function getDb(): Database.Database {
  return db;
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get a chat's display name by JID. Returns undefined if not found.
 */
export function getChatName(chatJid: string): string | undefined {
  const row = db
    .prepare('SELECT name FROM chats WHERE jid = ?')
    .get(chatJid) as { name: string } | undefined;
  return row?.name ?? undefined;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

function normalizeGroupAlias(alias: string): string {
  const trimmed = alias.trim();
  if (!trimmed) throw new Error('别名不能为空');
  return trimmed;
}

function normalizeGroupAliasTarget(chatJid: string): string {
  const trimmed = chatJid.trim();
  if (!trimmed) throw new Error('目标群不能为空');
  if (trimmed.startsWith('oc_')) return `fs:${trimmed}`;
  return trimmed;
}

export function setGroupAlias(alias: string, chatJid: string): void {
  const normalizedAlias = normalizeGroupAlias(alias);
  const normalizedChatJid = normalizeGroupAliasTarget(chatJid);
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO group_aliases (alias, chat_jid, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(alias) DO UPDATE SET
      chat_jid = excluded.chat_jid,
      updated_at = excluded.updated_at
  `,
  ).run(normalizedAlias, normalizedChatJid, now, now);
}

export function getGroupAlias(alias: string): string | undefined {
  const normalizedAlias = normalizeGroupAlias(alias);
  const row = db
    .prepare('SELECT chat_jid FROM group_aliases WHERE alias = ?')
    .get(normalizedAlias) as { chat_jid: string } | undefined;
  return row?.chat_jid;
}

export function getAllGroupAliases(): Record<string, string> {
  const rows = db
    .prepare(
      'SELECT alias, chat_jid FROM group_aliases ORDER BY alias COLLATE NOCASE',
    )
    .all() as Array<{ alias: string; chat_jid: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.alias] = row.chat_jid;
  }
  return result;
}

export function getAliasByJid(chatJid: string): string | undefined {
  const row = db
    .prepare('SELECT alias FROM group_aliases WHERE chat_jid = ? LIMIT 1')
    .get(chatJid) as { alias: string } | undefined;
  return row?.alias;
}

export function deleteGroupAlias(alias: string): boolean {
  const normalizedAlias = normalizeGroupAlias(alias);
  const result = db
    .prepare('DELETE FROM group_aliases WHERE alias = ?')
    .run(normalizedAlias);
  return result.changes > 0;
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_message_id, reply_to_message_content, reply_to_sender_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.reply_to_message_id ?? null,
    msg.reply_to_message_content ?? null,
    msg.reply_to_sender_name ?? null,
  );
}

/** 按消息 ID 查询发送者名称和内容 */
export function getMessageById(
  messageId: string,
): { sender_name: string; content: string } | undefined {
  return db
    .prepare('SELECT sender_name, content FROM messages WHERE id = ?')
    .get(messageId) as { sender_name: string; content: string } | undefined;
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

/**
 * 检查 DB 中是否存在某任务的 ipc_ 触发消息。
 * 用于 IPC pipe 模式下 missedMessages 过期时的补偿判断。
 */
export function hasIpcTriggerForTask(
  chatJid: string,
  taskId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM messages
       WHERE chat_jid = ? AND id LIKE 'ipc_%' AND content LIKE ?
       LIMIT 1`,
    )
    .get(chatJid, `%[task_id:${taskId}]%`);
  return !!row;
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

/**
 * 取某群最近 N 条用户消息（跨轮次），用于语音播报上下文。
 * 不受 cursor/sinceTimestamp 限制，返回最新的在最后。
 */
export function getRecentUserMessages(
  chatJid: string,
  limit: number = 5,
): Array<{ content: string; timestamp: string }> {
  // 排除 IPC 跨群消息（sender 格式 "大狗(fs_oc_xxx)"）：
  // 这些消息 is_bot_message=0（为了让 message loop 能扫到投递给目标 agent），
  // 但本质是其他 agent 的汇报/派工，不是用户消息，混入语音上下文会让 LLM 跑偏。
  const ipcSenderPrefix = `${ASSISTANT_NAME}(%`;
  const sql = `
    SELECT content, timestamp FROM (
      SELECT content, timestamp
      FROM messages
      WHERE chat_jid = ? AND is_from_me = 0 AND is_bot_message = 0
        AND content != '' AND content IS NOT NULL
        AND COALESCE(sender_name, '') NOT LIKE ?
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db.prepare(sql).all(chatJid, ipcSenderPrefix, limit) as Array<{
    content: string;
    timestamp: string;
  }>;
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

/** 消息上下文行（精简字段，用于 get_chat_context 返回） */
export interface ContextMessage {
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
}

function toolCallHistoryFilter(includeToolCalls: boolean): string {
  return includeToolCalls ? '' : `AND id NOT LIKE 'tool\\_%' ESCAPE '\\'`;
}

/**
 * 获取锚点时间戳前后 N 条消息。
 * 返回 { before, anchor, after }，anchor 是最接近锚点的那条消息。
 */
export function getMessageContext(
  chatJid: string,
  anchorTimestamp: string,
  beforeCount: number = 5,
  afterCount: number = 5,
  includeToolCalls: boolean = false,
): {
  before: ContextMessage[];
  anchor: ContextMessage | null;
  after: ContextMessage[];
} {
  // 锚点：最接近指定时间戳的消息
  const anchorRow = db
    .prepare(
      `
    SELECT sender_name, content, timestamp, is_from_me
    FROM messages
    WHERE chat_jid = ? AND content != '' AND content IS NOT NULL
      ${toolCallHistoryFilter(includeToolCalls)}
    ORDER BY ABS(julianday(timestamp) - julianday(?))
    LIMIT 1
  `,
    )
    .get(chatJid, anchorTimestamp) as ContextMessage | undefined;

  if (!anchorRow) {
    logger.info(
      { chatJid, anchorTimestamp },
      '[get_chat_context] 未找到锚点消息',
    );
    return { before: [], anchor: null, after: [] };
  }

  const actualAnchorTs = anchorRow.timestamp;

  // 锚点前 N 条
  const beforeRows = db
    .prepare(
      `
    SELECT * FROM (
      SELECT sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp < ? AND content != '' AND content IS NOT NULL
        ${toolCallHistoryFilter(includeToolCalls)}
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `,
    )
    .all(chatJid, actualAnchorTs, beforeCount) as ContextMessage[];

  // 锚点后 N 条
  const afterRows = db
    .prepare(
      `
    SELECT sender_name, content, timestamp, is_from_me
    FROM messages
    WHERE chat_jid = ? AND timestamp > ? AND content != '' AND content IS NOT NULL
      ${toolCallHistoryFilter(includeToolCalls)}
    ORDER BY timestamp
    LIMIT ?
  `,
    )
    .all(chatJid, actualAnchorTs, afterCount) as ContextMessage[];

  logger.info(
    {
      chatJid,
      anchorTimestamp: actualAnchorTs,
      before: beforeRows.length,
      after: afterRows.length,
    },
    '[get_chat_context] 上下文查询完成',
  );

  return {
    before: beforeRows,
    anchor: anchorRow,
    after: afterRows,
  };
}

/**
 * 按消息 ID 定位并展开前后 N 条上下文。
 * 消息 ID 是 messages 表主键（全局唯一），从锚点行自身解析所属会话，仅在该会话内展开。
 * 含 bot 回复，只过滤空内容（与 getMessageContext 一致）。
 * ID 不存在时返回 { before: [], anchor: null, after: [] }。
 */
export function getMessageContextById(
  messageId: string,
  beforeCount: number = 5,
  afterCount: number = 5,
  includeToolCalls: boolean = false,
): {
  before: ContextMessage[];
  anchor: ContextMessage | null;
  after: ContextMessage[];
} {
  // 锚点：按主键直接命中（额外取 chat_jid 用于在同会话内展开）
  const anchorRow = db
    .prepare(
      `
    SELECT chat_jid, sender_name, content, timestamp, is_from_me
    FROM messages
    WHERE id = ?
      ${toolCallHistoryFilter(includeToolCalls)}
  `,
    )
    .get(messageId) as (ContextMessage & { chat_jid: string }) | undefined;

  if (!anchorRow) {
    logger.info({ messageId }, '[get_message_by_id] 未找到消息');
    return { before: [], anchor: null, after: [] };
  }

  const chatJid = anchorRow.chat_jid;
  const anchorTs = anchorRow.timestamp;

  // 锚点前 N 条（倒序取、正序返回）
  const beforeRows = db
    .prepare(
      `
    SELECT * FROM (
      SELECT sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp < ? AND content != '' AND content IS NOT NULL
        ${toolCallHistoryFilter(includeToolCalls)}
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `,
    )
    .all(chatJid, anchorTs, beforeCount) as ContextMessage[];

  // 锚点后 N 条
  const afterRows = db
    .prepare(
      `
    SELECT sender_name, content, timestamp, is_from_me
    FROM messages
    WHERE chat_jid = ? AND timestamp > ? AND content != '' AND content IS NOT NULL
      ${toolCallHistoryFilter(includeToolCalls)}
    ORDER BY timestamp
    LIMIT ?
  `,
    )
    .all(chatJid, anchorTs, afterCount) as ContextMessage[];

  const anchor: ContextMessage = {
    sender_name: anchorRow.sender_name,
    content: anchorRow.content,
    timestamp: anchorRow.timestamp,
    is_from_me: anchorRow.is_from_me,
  };

  logger.info(
    { messageId, chatJid, before: beforeRows.length, after: afterRows.length },
    '[get_message_by_id] 上下文查询完成',
  );

  return { before: beforeRows, anchor, after: afterRows };
}

/**
 * 钳制 get_message_range 的入参：offset 非负，limit 落在 [1, 200]，默认 limit=20。
 * 纯函数，便于单测。
 */
export function clampRangeParams(
  offset?: number,
  limit?: number,
): { offset: number; limit: number } {
  const safeOffset = Math.max(0, Math.floor(offset ?? 0));
  const rawLimit = Math.floor(limit ?? 20);
  const safeLimit = Math.min(200, Math.max(1, rawLimit));
  return { offset: safeOffset, limit: safeLimit };
}

/**
 * 按位置区间（OFFSET）查询会话消息。
 * 倒序跳过最新 offset 条，取 limit 条，结果反转为正序返回（最早的在前）。
 * 含 bot 回复，只过滤空内容。入参假设已由 clampRangeParams 钳制。
 */
export function getMessageRange(
  chatJid: string,
  offset: number = 0,
  limit: number = 20,
  includeToolCalls: boolean = false,
): ContextMessage[] {
  return db
    .prepare(
      `
    SELECT * FROM (
      SELECT sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND content != '' AND content IS NOT NULL
        ${toolCallHistoryFilter(includeToolCalls)}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    ) ORDER BY timestamp
  `,
    )
    .all(chatJid, limit, offset) as ContextMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

function newLedgerId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

type TaskLedgerTaskRow = Omit<TaskLedgerTask, 'acceptance_criteria'> & {
  acceptance_criteria: string;
};

const TASK_LEDGER_TASK_COLUMNS =
  'id, title, project, task_type, status, priority, description, desired_outcome, acceptance_criteria, owner_group, chat_jid, created_by, artifact_root, prd_path, spec_path, created_at, updated_at, completed_at';
const TASK_LEDGER_CHECKLIST_COLUMNS =
  'id, task_id, title, status, position, notes, created_at, updated_at';
const TASK_LEDGER_TEST_CASE_COLUMNS =
  'id, task_id, title, description, status, evidence, position, created_at, updated_at';
const TASK_LEDGER_EVENT_COLUMNS =
  'id, task_id, event_type, summary, details, actor_group, actor_sender, created_at';

const TASK_LEDGER_GLOBAL_DIR =
  process.env.NANOCLAW_TASK_LEDGER_DIR ||
  (process.env.VITEST
    ? path.join(
        process.env.TMPDIR || '/tmp',
        `nanoclaw-task-ledger-test-${process.pid}`,
        'task-ledger',
      )
    : path.join(GROUPS_DIR, 'global', 'task-ledger'));

function safeLedgerPathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'task';
}

function defaultTaskArtifactRoot(taskId: string): string {
  return path.join(TASK_LEDGER_GLOBAL_DIR, safeLedgerPathSegment(taskId));
}

function writeFileIfMissing(filePath: string, content: string): void {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function ensureTaskLedgerArtifactFiles(detail: TaskLedgerDetail): void {
  const root = detail.task.artifact_root;
  if (!root) return;
  fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });
  writeFileIfMissing(
    path.join(root, 'prd.md'),
    `# ${detail.task.title}\n\n状态：草稿\n\n## 问题 / 需求\n\n${detail.task.description || ''}\n\n## 目标效果\n\n${detail.task.desired_outcome || ''}\n`,
  );
  writeFileIfMissing(
    path.join(root, 'acceptance.md'),
    `# 验收标准\n\n${detail.task.acceptance_criteria.map((item) => `- ${item}`).join('\n')}\n`,
  );
  writeFileIfMissing(
    path.join(root, 'e2e-cases.md'),
    `# E2E 用例\n\n${detail.test_cases.map((item) => `- [ ] ${item.id} ${item.title} (${item.status})`).join('\n')}\n`,
  );
  writeFileIfMissing(path.join(root, 'bugs.md'), '# Bug 历史\n\n');
  writeFileIfMissing(path.join(root, 'decisions.md'), '# 决策记录\n\n');
}

function syncTaskLedgerArtifactIndex(taskId: string): void {
  const detail = getTaskLedgerTask(taskId);
  if (!detail?.task.artifact_root) return;
  ensureTaskLedgerArtifactFiles(detail);
  const root = detail.task.artifact_root;
  const index = {
    task_id: detail.task.id,
    title: detail.task.title,
    project: detail.task.project,
    task_type: detail.task.task_type,
    status: detail.task.status,
    owner_group: detail.task.owner_group,
    chat_jid: detail.task.chat_jid,
    artifact_root: root,
    artifacts: {
      prd: detail.task.prd_path || path.join(root, 'prd.md'),
      acceptance: path.join(root, 'acceptance.md'),
      e2e_cases: path.join(root, 'e2e-cases.md'),
      bugs: path.join(root, 'bugs.md'),
      decisions: path.join(root, 'decisions.md'),
      evidence_dir: path.join(root, 'evidence'),
      task_index: path.join(root, 'task.yaml'),
      spec: detail.task.spec_path,
    },
    desired_outcome: detail.task.desired_outcome,
    acceptance_criteria: detail.task.acceptance_criteria,
    checklist: detail.checklist.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      notes: item.notes,
      position: item.position,
    })),
    test_cases: detail.test_cases.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      status: item.status,
      evidence: item.evidence,
      position: item.position,
    })),
    events: detail.events.map((event) => ({
      id: event.id,
      type: event.event_type,
      summary: event.summary,
      details: event.details,
      actor_group: event.actor_group,
      actor_sender: event.actor_sender,
      created_at: event.created_at,
    })),
    updated_at: detail.task.updated_at,
  };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'task.yaml'),
    JSON.stringify(index, null, 2),
    'utf8',
  );
}

function rowToTaskLedgerTask(row: TaskLedgerTaskRow): TaskLedgerTask {
  return {
    ...row,
    acceptance_criteria: parseJsonArray(row.acceptance_criteria),
  };
}

export function createTaskLedgerTask(input: {
  id?: string;
  title: string;
  project: string;
  task_type: TaskLedgerType;
  status?: TaskLedgerStatus;
  priority?: string;
  description?: string | null;
  desired_outcome?: string | null;
  acceptance_criteria?: string[];
  owner_group: string;
  chat_jid?: string | null;
  created_by?: string | null;
  artifact_root?: string | null;
  prd_path?: string | null;
  spec_path?: string | null;
  checklist?: Array<{
    title: string;
    status?: TaskLedgerChecklistStatus;
    notes?: string | null;
  }>;
  test_cases?: Array<{
    title: string;
    description?: string | null;
    status?: TaskLedgerTestCaseStatus;
    evidence?: string | null;
  }>;
}): TaskLedgerDetail {
  const now = new Date().toISOString();
  const id = input.id || newLedgerId('tl');
  const status = input.status || 'draft';
  const completedAt = status === 'done' || status === 'cancelled' ? now : null;
  const artifactRoot = input.artifact_root || defaultTaskArtifactRoot(id);
  const prdPath = input.prd_path || path.join(artifactRoot, 'prd.md');

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO task_ledger_tasks (
        id, title, project, task_type, status, priority, description, desired_outcome,
        acceptance_criteria, owner_group, chat_jid, created_by, artifact_root, prd_path, spec_path,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.title,
      input.project,
      input.task_type,
      status,
      input.priority || 'normal',
      input.description || null,
      input.desired_outcome || null,
      JSON.stringify(input.acceptance_criteria || []),
      input.owner_group,
      input.chat_jid || null,
      input.created_by || null,
      artifactRoot,
      prdPath,
      input.spec_path || null,
      now,
      now,
      completedAt,
    );

    for (const [index, item] of (input.checklist || []).entries()) {
      db.prepare(
        `INSERT INTO task_ledger_checklist (
          id, task_id, title, status, position, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newLedgerId('cli'),
        id,
        item.title,
        item.status || 'todo',
        index,
        item.notes || null,
        now,
        now,
      );
    }

    for (const [index, item] of (input.test_cases || []).entries()) {
      db.prepare(
        `INSERT INTO task_ledger_test_cases (
          id, task_id, title, description, status, evidence, position, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newLedgerId('tc'),
        id,
        item.title,
        item.description || null,
        item.status || 'pending',
        item.evidence || null,
        index,
        now,
        now,
      );
    }

    db.prepare(
      `INSERT INTO task_ledger_events (
        task_id, event_type, summary, details, actor_group, actor_sender, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      'created',
      '任务已创建',
      input.desired_outcome || null,
      input.owner_group,
      input.created_by || null,
      now,
    );
  });
  tx();

  const detail = getTaskLedgerTask(id);
  if (!detail) throw new Error(`Task ledger row missing after create: ${id}`);
  syncTaskLedgerArtifactIndex(id);
  return getTaskLedgerTask(id) || detail;
}

export function getTaskLedgerTask(id: string): TaskLedgerDetail | undefined {
  const taskRow = db
    .prepare(
      `SELECT ${TASK_LEDGER_TASK_COLUMNS} FROM task_ledger_tasks WHERE id = ?`,
    )
    .get(id) as TaskLedgerTaskRow | undefined;
  if (!taskRow) return undefined;
  const checklist = db
    .prepare(
      `SELECT ${TASK_LEDGER_CHECKLIST_COLUMNS} FROM task_ledger_checklist WHERE task_id = ? ORDER BY position, created_at`,
    )
    .all(id) as TaskLedgerChecklistItem[];
  const testCases = db
    .prepare(
      `SELECT ${TASK_LEDGER_TEST_CASE_COLUMNS} FROM task_ledger_test_cases WHERE task_id = ? ORDER BY position, created_at`,
    )
    .all(id) as TaskLedgerTestCase[];
  const events = db
    .prepare(
      `SELECT ${TASK_LEDGER_EVENT_COLUMNS} FROM task_ledger_events WHERE task_id = ? ORDER BY created_at, id`,
    )
    .all(id) as TaskLedgerEvent[];
  return {
    task: rowToTaskLedgerTask(taskRow),
    checklist,
    test_cases: testCases,
    events,
  };
}

export function listTaskLedgerTasks(
  filters: {
    owner_group?: string;
    project?: string;
    status?: TaskLedgerStatus;
    task_type?: TaskLedgerType;
    include_done?: boolean;
    limit?: number;
  } = {},
): TaskLedgerTask[] {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filters.owner_group) {
    clauses.push('owner_group = ?');
    values.push(filters.owner_group);
  }
  if (filters.project) {
    clauses.push('project = ?');
    values.push(filters.project);
  }
  if (filters.status) {
    clauses.push('status = ?');
    values.push(filters.status);
  } else if (!filters.include_done) {
    clauses.push("status NOT IN ('done', 'cancelled')");
  }
  if (filters.task_type) {
    clauses.push('task_type = ?');
    values.push(filters.task_type);
  }

  const limit = Math.min(100, Math.max(1, Math.floor(filters.limit || 20)));
  values.push(limit);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT ${TASK_LEDGER_TASK_COLUMNS} FROM task_ledger_tasks ${where} ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...values) as TaskLedgerTaskRow[];
  return rows.map(rowToTaskLedgerTask);
}

export function updateTaskLedgerTask(
  id: string,
  updates: Partial<
    Pick<
      TaskLedgerTask,
      | 'title'
      | 'project'
      | 'task_type'
      | 'status'
      | 'priority'
      | 'description'
      | 'desired_outcome'
      | 'acceptance_criteria'
      | 'artifact_root'
      | 'prd_path'
      | 'spec_path'
    >
  >,
): TaskLedgerDetail | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];
  const now = new Date().toISOString();

  for (const key of [
    'title',
    'project',
    'task_type',
    'status',
    'priority',
    'description',
    'desired_outcome',
    'artifact_root',
    'prd_path',
    'spec_path',
  ] as const) {
    if (updates[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(updates[key]);
    }
  }
  if (updates.acceptance_criteria !== undefined) {
    fields.push('acceptance_criteria = ?');
    values.push(JSON.stringify(updates.acceptance_criteria));
  }
  if (updates.status !== undefined) {
    fields.push('completed_at = ?');
    values.push(
      updates.status === 'done' || updates.status === 'cancelled' ? now : null,
    );
  }
  fields.push('updated_at = ?');
  values.push(now);

  values.push(id);
  const result = db
    .prepare(`UPDATE task_ledger_tasks SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
  if (result.changes === 0) return undefined;
  syncTaskLedgerArtifactIndex(id);
  return getTaskLedgerTask(id);
}

export function addTaskLedgerEvent(input: {
  task_id: string;
  event_type: string;
  summary: string;
  details?: string | null;
  actor_group?: string | null;
  actor_sender?: string | null;
}): TaskLedgerEvent | undefined {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO task_ledger_events (
      task_id, event_type, summary, details, actor_group, actor_sender, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.task_id,
      input.event_type,
      input.summary,
      input.details || null,
      input.actor_group || null,
      input.actor_sender || null,
      now,
    );
  db.prepare('UPDATE task_ledger_tasks SET updated_at = ? WHERE id = ?').run(
    now,
    input.task_id,
  );
  syncTaskLedgerArtifactIndex(input.task_id);
  return db
    .prepare(
      `SELECT ${TASK_LEDGER_EVENT_COLUMNS} FROM task_ledger_events WHERE id = ?`,
    )
    .get(result.lastInsertRowid) as TaskLedgerEvent | undefined;
}

export function upsertTaskLedgerChecklistItem(input: {
  task_id: string;
  id?: string;
  title: string;
  status?: TaskLedgerChecklistStatus;
  notes?: string | null;
  position?: number;
}): TaskLedgerChecklistItem | undefined {
  const now = new Date().toISOString();
  const existing = input.id
    ? (db
        .prepare(
          `SELECT ${TASK_LEDGER_CHECKLIST_COLUMNS} FROM task_ledger_checklist WHERE id = ? AND task_id = ?`,
        )
        .get(input.id, input.task_id) as TaskLedgerChecklistItem | undefined)
    : (db
        .prepare(
          `SELECT ${TASK_LEDGER_CHECKLIST_COLUMNS} FROM task_ledger_checklist WHERE task_id = ? AND title = ?`,
        )
        .get(input.task_id, input.title) as
        | TaskLedgerChecklistItem
        | undefined);

  if (existing) {
    db.prepare(
      `UPDATE task_ledger_checklist
       SET title = ?, status = ?, notes = ?, position = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.title,
      input.status || existing.status,
      input.notes !== undefined ? input.notes : existing.notes,
      input.position !== undefined ? input.position : existing.position,
      now,
      existing.id,
    );
    db.prepare('UPDATE task_ledger_tasks SET updated_at = ? WHERE id = ?').run(
      now,
      input.task_id,
    );
    syncTaskLedgerArtifactIndex(input.task_id);
    return db
      .prepare(
        `SELECT ${TASK_LEDGER_CHECKLIST_COLUMNS} FROM task_ledger_checklist WHERE id = ?`,
      )
      .get(existing.id) as TaskLedgerChecklistItem | undefined;
  }

  const maxRow = db
    .prepare(
      'SELECT COALESCE(MAX(position), -1) AS max_position FROM task_ledger_checklist WHERE task_id = ?',
    )
    .get(input.task_id) as { max_position: number };
  const id = newLedgerId('cli');
  db.prepare(
    `INSERT INTO task_ledger_checklist (
      id, task_id, title, status, position, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.task_id,
    input.title,
    input.status || 'todo',
    input.position !== undefined ? input.position : maxRow.max_position + 1,
    input.notes || null,
    now,
    now,
  );
  db.prepare('UPDATE task_ledger_tasks SET updated_at = ? WHERE id = ?').run(
    now,
    input.task_id,
  );
  syncTaskLedgerArtifactIndex(input.task_id);
  return db
    .prepare(
      `SELECT ${TASK_LEDGER_CHECKLIST_COLUMNS} FROM task_ledger_checklist WHERE id = ?`,
    )
    .get(id) as TaskLedgerChecklistItem | undefined;
}

export function upsertTaskLedgerTestCase(input: {
  task_id: string;
  id?: string;
  title: string;
  description?: string | null;
  status?: TaskLedgerTestCaseStatus;
  evidence?: string | null;
  position?: number;
}): TaskLedgerTestCase | undefined {
  const now = new Date().toISOString();
  const existing = input.id
    ? (db
        .prepare(
          `SELECT ${TASK_LEDGER_TEST_CASE_COLUMNS} FROM task_ledger_test_cases WHERE id = ? AND task_id = ?`,
        )
        .get(input.id, input.task_id) as TaskLedgerTestCase | undefined)
    : (db
        .prepare(
          `SELECT ${TASK_LEDGER_TEST_CASE_COLUMNS} FROM task_ledger_test_cases WHERE task_id = ? AND title = ?`,
        )
        .get(input.task_id, input.title) as TaskLedgerTestCase | undefined);

  if (existing) {
    db.prepare(
      `UPDATE task_ledger_test_cases
       SET title = ?, description = ?, status = ?, evidence = ?, position = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.title,
      input.description !== undefined
        ? input.description
        : existing.description,
      input.status || existing.status,
      input.evidence !== undefined ? input.evidence : existing.evidence,
      input.position !== undefined ? input.position : existing.position,
      now,
      existing.id,
    );
    db.prepare('UPDATE task_ledger_tasks SET updated_at = ? WHERE id = ?').run(
      now,
      input.task_id,
    );
    syncTaskLedgerArtifactIndex(input.task_id);
    return db
      .prepare(
        `SELECT ${TASK_LEDGER_TEST_CASE_COLUMNS} FROM task_ledger_test_cases WHERE id = ?`,
      )
      .get(existing.id) as TaskLedgerTestCase | undefined;
  }

  const maxRow = db
    .prepare(
      'SELECT COALESCE(MAX(position), -1) AS max_position FROM task_ledger_test_cases WHERE task_id = ?',
    )
    .get(input.task_id) as { max_position: number };
  const id = newLedgerId('tc');
  db.prepare(
    `INSERT INTO task_ledger_test_cases (
      id, task_id, title, description, status, evidence, position, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.task_id,
    input.title,
    input.description || null,
    input.status || 'pending',
    input.evidence || null,
    input.position !== undefined ? input.position : maxRow.max_position + 1,
    now,
    now,
  );
  db.prepare('UPDATE task_ledger_tasks SET updated_at = ? WHERE id = ?').run(
    now,
    input.task_id,
  );
  syncTaskLedgerArtifactIndex(input.task_id);
  return db
    .prepare(
      `SELECT ${TASK_LEDGER_TEST_CASE_COLUMNS} FROM task_ledger_test_cases WHERE id = ?`,
    )
    .get(id) as TaskLedgerTestCase | undefined;
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
        custom_cwd: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
    customCwd: row.custom_cwd || undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, custom_cwd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
    group.customCwd || null,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
    custom_cwd: string | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
      customCwd: row.custom_cwd || undefined,
    };
  }
  return result;
}

// --- Account rotate config accessors ---

export function getRotateEnabled(): boolean {
  const row = db
    .prepare('SELECT value FROM account_rotate_config WHERE key = ?')
    .get('enabled') as { value: string } | undefined;
  // 默认开启自动轮换（DB 无记录时返回 true）
  return row ? row.value === 'true' : true;
}

export function setRotateEnabled(enabled: boolean): void {
  db.prepare(
    'INSERT OR REPLACE INTO account_rotate_config (key, value) VALUES (?, ?)',
  ).run('enabled', String(enabled));
}

export function getRotateIndex(groupFolder?: string): number {
  const key = groupFolder ? `current_index:${groupFolder}` : 'current_index';
  const row = db
    .prepare('SELECT value FROM account_rotate_config WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

export function setRotateIndex(index: number, groupFolder?: string): void {
  const key = groupFolder ? `current_index:${groupFolder}` : 'current_index';
  db.prepare(
    'INSERT OR REPLACE INTO account_rotate_config (key, value) VALUES (?, ?)',
  ).run(key, String(index));
}

export function getLastRotateAt(groupFolder?: string): number | null {
  const key = groupFolder ? `last_rotate_at:${groupFolder}` : 'last_rotate_at';
  const row = db
    .prepare('SELECT value FROM account_rotate_config WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : null;
}

export function setLastRotateAt(ts: number, groupFolder?: string): void {
  const key = groupFolder ? `last_rotate_at:${groupFolder}` : 'last_rotate_at';
  db.prepare(
    'INSERT OR REPLACE INTO account_rotate_config (key, value) VALUES (?, ?)',
  ).run(key, String(ts));
}

// --- Last sender lookup ---

export function getLastSenderForChat(chatJid: string): string | null {
  const row = db
    .prepare(
      'SELECT sender FROM messages WHERE chat_jid = ? AND is_bot_message = 0 AND sender != ? ORDER BY timestamp DESC LIMIT 1',
    )
    .get(chatJid, '') as { sender: string } | undefined;
  return row?.sender ?? null;
}

// --- Feishu tokens ---

export interface FeishuTokenRecord {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

export function getFeishuTokenByUserId(
  userId: string,
): (FeishuTokenRecord & { chat_jid: string }) | null {
  const row = db
    .prepare(
      'SELECT access_token, refresh_token, expires_at, chat_jid FROM feishu_tokens WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1',
    )
    .get(userId) as (FeishuTokenRecord & { chat_jid: string }) | undefined;
  return row ?? null;
}

export function getAllFeishuTokenUsers(): { user_id: string }[] {
  return db
    .prepare("SELECT DISTINCT user_id FROM feishu_tokens WHERE user_id != ''")
    .all() as { user_id: string }[];
}

export function setFeishuToken(
  userId: string,
  chatJid: string,
  accessToken: string,
  refreshToken: string,
  expiresAt: string,
): void {
  db.prepare(
    'INSERT OR REPLACE INTO feishu_tokens (user_id, chat_jid, access_token, refresh_token, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    userId,
    chatJid,
    accessToken,
    refreshToken,
    expiresAt,
    new Date().toISOString(),
  );
}

// --- OAuth credentials (usage API) ---

export function getOAuthCredential(secretName: string): OAuthCredential | null {
  return (
    (db
      .prepare('SELECT * FROM oauth_credentials WHERE secret_name = ?')
      .get(secretName) as OAuthCredential | undefined) ?? null
  );
}

export function getAllOAuthCredentials(): OAuthCredential[] {
  return db
    .prepare('SELECT * FROM oauth_credentials')
    .all() as OAuthCredential[];
}

export function upsertOAuthCredential(
  secretName: string,
  refreshToken: string,
  accessToken?: string,
  expiresAt?: number,
): void {
  db.prepare(
    `INSERT INTO oauth_credentials (secret_name, refresh_token, access_token, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(secret_name) DO UPDATE SET
       refresh_token = excluded.refresh_token,
       access_token = COALESCE(excluded.access_token, access_token),
       expires_at = COALESCE(excluded.expires_at, expires_at),
       updated_at = excluded.updated_at`,
  ).run(
    secretName,
    refreshToken,
    accessToken ?? null,
    expiresAt ?? null,
    new Date().toISOString(),
  );
}

export function updateOAuthTokens(
  secretName: string,
  accessToken: string,
  refreshToken: string,
  expiresAt: number,
): void {
  db.prepare(
    `UPDATE oauth_credentials
     SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ?
     WHERE secret_name = ?`,
  ).run(
    accessToken,
    refreshToken,
    expiresAt,
    new Date().toISOString(),
    secretName,
  );
}

export function updateOAuthUsageCache(
  secretName: string,
  usage: string | null,
  errorState?: string,
): void {
  db.prepare(
    `UPDATE oauth_credentials
     SET cached_usage = ?, error_state = ?, last_usage_check = ?
     WHERE secret_name = ?`,
  ).run(usage, errorState ?? null, Date.now(), secretName);
}

export function deleteOAuthCredential(secretName: string): void {
  db.prepare('DELETE FROM oauth_credentials WHERE secret_name = ?').run(
    secretName,
  );
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}

// --- Commander 派工账本 (delegation_tasks) ---

/** 占在办槽位的状态（一群同时只能有一个）：进行态 + 等待态 */
export const DELEGATION_OCCUPYING_STATUSES: DelegationStatus[] = [
  'dispatched',
  'progress',
  'blocked',
  'question',
];

interface DelegationRow {
  task_id: string;
  source_group: string;
  source_jid: string;
  target_group: string;
  target_jid: string;
  title: string | null;
  status: string;
  summary: string | null;
  details: string | null;
  artifacts: string | null;
  dispatch_msg_id: string | null;
  dispatched_at: string;
  last_report_at: string | null;
  updated_at: string;
}

function rowToDelegation(row: DelegationRow): DelegationTask {
  return {
    taskId: row.task_id,
    sourceGroup: row.source_group,
    sourceJid: row.source_jid,
    targetGroup: row.target_group,
    targetJid: row.target_jid,
    title: row.title || undefined,
    status: row.status as DelegationStatus,
    summary: row.summary || undefined,
    details: row.details || undefined,
    artifacts: row.artifacts ? JSON.parse(row.artifacts) : undefined,
    dispatchMsgId: row.dispatch_msg_id || undefined,
    dispatchedAt: row.dispatched_at,
    lastReportAt: row.last_report_at || undefined,
    updatedAt: row.updated_at,
  };
}

/** 派发落账：生成 task_id、status=dispatched，返回新建的任务行 */
export function createDelegation(params: {
  sourceGroup: string;
  sourceJid: string;
  targetGroup: string;
  targetJid: string;
  title?: string;
}): DelegationTask {
  if (!params.sourceGroup || !params.sourceJid) {
    throw new Error('createDelegation requires sourceGroup and sourceJid');
  }
  const now = new Date().toISOString();
  const taskId = `dlg_${Date.now()}_${randomBytes(4).toString('hex')}`;
  db.prepare(
    `INSERT INTO delegation_tasks (task_id, source_group, source_jid, target_group, target_jid, title, status, dispatched_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'dispatched', ?, ?)`,
  ).run(
    taskId,
    params.sourceGroup,
    params.sourceJid,
    params.targetGroup,
    params.targetJid,
    params.title || null,
    now,
    now,
  );
  return getDelegation(taskId)!;
}

/** 回写派发消息 id */
export function setDelegationDispatchMsgId(
  taskId: string,
  msgId: string,
): void {
  db.prepare(
    `UPDATE delegation_tasks SET dispatch_msg_id = ?, updated_at = ? WHERE task_id = ?`,
  ).run(msgId, new Date().toISOString(), taskId);
}

/** 汇报更新：刷新 status/summary/details/artifacts/last_report_at */
export function updateDelegationOnReport(params: {
  taskId: string;
  status: DelegationStatus;
  summary?: string;
  details?: string;
  artifacts?: string[];
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE delegation_tasks
     SET status = ?, summary = ?, details = ?, artifacts = ?, last_report_at = ?, updated_at = ?
     WHERE task_id = ?`,
  ).run(
    params.status,
    params.summary ?? null,
    params.details ?? null,
    params.artifacts ? JSON.stringify(params.artifacts) : null,
    now,
    now,
    params.taskId,
  );
}

/**
 * 续投（/delegate reply）：占槽态任务状态回置 progress。
 * 同时把 last_report_at 刷到 now——续投本身是一次新交互，
 * 否则会按旧的 last_report_at 立刻被判失联。
 */
export function replyDelegation(taskId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE delegation_tasks SET status = 'progress', last_report_at = ?, updated_at = ? WHERE task_id = ?`,
  ).run(now, now, taskId);
}

/**
 * 重派（/delegate retry）：状态回置 dispatched。
 * 刷新 dispatched_at 并清空 last_report_at——重派等于重新计时，
 * 否则会按旧时间立刻被判失联。
 */
export function resetDelegationToDispatched(taskId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE delegation_tasks SET status = 'dispatched', dispatched_at = ?, last_report_at = NULL, updated_at = ? WHERE task_id = ?`,
  ).run(now, now, taskId);
}

/** 关闭（/delegate close）：状态置 closed，释放在办槽位 */
export function closeDelegation(taskId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE delegation_tasks SET status = 'closed', updated_at = ? WHERE task_id = ?`,
  ).run(now, taskId);
}

/** 派发失败：状态置 failed，释放在办槽位，同时保留审计摘要 */
export function failDelegation(taskId: string, summary?: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE delegation_tasks
     SET status = 'failed', summary = COALESCE(?, summary), last_report_at = ?, updated_at = ?
     WHERE task_id = ?`,
  ).run(summary ?? null, now, now, taskId);
}

export function getDelegation(taskId: string): DelegationTask | undefined {
  const row = db
    .prepare('SELECT * FROM delegation_tasks WHERE task_id = ?')
    .get(taskId) as DelegationRow | undefined;
  return row ? rowToDelegation(row) : undefined;
}

/** 列账本，可选按 source_group / target_group 过滤，按派发时间倒序 */
export function listDelegations(filters?: {
  sourceGroup?: string;
  targetGroup?: string;
  group?: string;
}): DelegationTask[] {
  const where: string[] = [];
  const args: string[] = [];
  if (filters?.sourceGroup) {
    where.push('source_group = ?');
    args.push(filters.sourceGroup);
  }
  if (filters?.targetGroup) {
    where.push('target_group = ?');
    args.push(filters.targetGroup);
  }
  if (filters?.group) {
    where.push('(source_group = ? OR target_group = ?)');
    args.push(filters.group, filters.group);
  }
  const sql = `SELECT * FROM delegation_tasks${
    where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  } ORDER BY dispatched_at DESC`;
  const rows = db.prepare(sql).all(...args) as DelegationRow[];
  return rows.map(rowToDelegation);
}

/**
 * 反查某群唯一占槽态任务（dispatched/progress/blocked/question）。
 * 依赖"一群一在办任务"约束保证唯一；取最近派发的一条兜底。
 */
export function getActiveDelegationByGroup(
  targetGroup: string,
): DelegationTask | undefined {
  const placeholders = DELEGATION_OCCUPYING_STATUSES.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT * FROM delegation_tasks
       WHERE target_group = ? AND status IN (${placeholders})
       ORDER BY dispatched_at DESC LIMIT 1`,
    )
    .get(targetGroup, ...DELEGATION_OCCUPYING_STATUSES) as
    | DelegationRow
    | undefined;
  return row ? rowToDelegation(row) : undefined;
}

/**
 * 获取唯一 isMain 群。0 个或 >1 个均抛错（不静默降级，避免汇报投错群）。
 */
export function getMainGroup(): RegisteredGroup & { jid: string } {
  const groups = getAllRegisteredGroups();
  const mains = Object.entries(groups).filter(([, g]) => g.isMain);
  if (mains.length === 0) {
    throw new Error('No main group registered (isMain=true)');
  }
  if (mains.length > 1) {
    throw new Error(
      `Multiple main groups registered (${mains.length}), expected exactly 1`,
    );
  }
  const [jid, group] = mains[0];
  return { jid, ...group };
}
