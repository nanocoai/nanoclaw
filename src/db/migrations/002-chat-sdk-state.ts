import type { Migration } from './index.js';
import {
  colId,
  colLongText,
  colText,
  colTimestamp,
  nowDefault,
  qIdent,
  tableSuffix,
  type MigrationContext,
} from './helpers.js';
import type { ICentralDb } from '../central/types.js';

export const migration002: Migration = {
  version: 2,
  name: 'chat-sdk-state',
  up(db: ICentralDb, ctx: MigrationContext) {
    const id = colId(ctx);
    const txt = colText(ctx);
    const long = colLongText(ctx);
    const keyCol = qIdent(ctx, 'key');
    const t = tableSuffix(ctx);
    const now = nowDefault(ctx);
    db.exec(`
      CREATE TABLE chat_sdk_kv (
        ${keyCol} ${id} PRIMARY KEY,
        value ${long} NOT NULL,
        expires_at INTEGER
      )${t};

      CREATE TABLE chat_sdk_subscriptions (
        thread_id ${id} PRIMARY KEY,
        subscribed_at ${colTimestamp(ctx)} NOT NULL DEFAULT ${now}
      )${t};

      CREATE TABLE chat_sdk_locks (
        thread_id ${id} PRIMARY KEY,
        token ${txt} NOT NULL,
        expires_at INTEGER NOT NULL
      )${t};

      CREATE TABLE chat_sdk_lists (
        ${keyCol} ${id} NOT NULL,
        idx INTEGER NOT NULL,
        value ${long} NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (${keyCol}, idx)
      )${t};
    `);
  },
};
