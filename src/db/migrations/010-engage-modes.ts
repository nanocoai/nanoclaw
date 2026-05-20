/**
 * Replace `trigger_rules` (opaque JSON) + `response_scope` (conflated axis)
 * with four explicit orthogonal columns on messaging_group_agents.
 */
import { log } from '../../log.js';
import type { ICentralDb } from '../central/types.js';
import type { Migration } from './index.js';
import { colText, hasColumn, type MigrationContext } from './helpers.js';

interface LegacyRow {
  id: string;
  trigger_rules: string | null;
  response_scope: string | null;
}

function backfill(row: LegacyRow): {
  engage_mode: 'pattern' | 'mention' | 'mention-sticky';
  engage_pattern: string | null;
  sender_scope: 'all' | 'known';
  ignored_message_policy: 'drop' | 'accumulate';
} {
  let parsed: Record<string, unknown> = {};
  if (row.trigger_rules) {
    try {
      parsed = JSON.parse(row.trigger_rules) as Record<string, unknown>;
    } catch {
      // Invalid JSON falls through to conservative defaults.
    }
  }

  const pattern = typeof parsed.pattern === 'string' && parsed.pattern.length > 0 ? (parsed.pattern as string) : null;
  const requiresTrigger = parsed.requiresTrigger;

  let engage_mode: 'pattern' | 'mention' | 'mention-sticky' = 'mention';
  let engage_pattern: string | null = null;
  if (pattern) {
    engage_mode = 'pattern';
    engage_pattern = pattern;
  } else if (requiresTrigger === false || row.response_scope === 'all') {
    engage_mode = 'pattern';
    engage_pattern = '.';
  }

  const sender_scope: 'all' | 'known' = row.response_scope === 'allowlisted' ? 'known' : 'all';

  return { engage_mode, engage_pattern, sender_scope, ignored_message_policy: 'drop' };
}

export const migration010: Migration = {
  version: 10,
  name: 'engage-modes',
  up: (db: ICentralDb, ctx: MigrationContext) => {
    const txt = colText(ctx);
    if (!hasColumn(db, ctx, 'messaging_group_agents', 'engage_mode')) {
      db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN engage_mode ${txt}`);
    }
    if (!hasColumn(db, ctx, 'messaging_group_agents', 'engage_pattern')) {
      db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN engage_pattern ${txt}`);
    }
    if (!hasColumn(db, ctx, 'messaging_group_agents', 'sender_scope')) {
      db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN sender_scope ${txt}`);
    }
    if (!hasColumn(db, ctx, 'messaging_group_agents', 'ignored_message_policy')) {
      db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN ignored_message_policy ${txt}`);
    }

    const rows = db
      .prepare('SELECT id, trigger_rules, response_scope FROM messaging_group_agents')
      .all() as LegacyRow[];
    const update = db.prepare(
      `UPDATE messaging_group_agents
         SET engage_mode            = ?,
             engage_pattern         = ?,
             sender_scope           = ?,
             ignored_message_policy = ?
       WHERE id = ?`,
    );
    for (const row of rows) {
      const v = backfill(row);
      update.run(v.engage_mode, v.engage_pattern, v.sender_scope, v.ignored_message_policy, row.id);
    }

    if (ctx.dialect === 'mysql') {
      db.exec(`
        ALTER TABLE messaging_group_agents DROP COLUMN trigger_rules;
        ALTER TABLE messaging_group_agents DROP COLUMN response_scope;
      `);
    } else {
      db.exec(`
        ALTER TABLE messaging_group_agents DROP COLUMN trigger_rules;
        ALTER TABLE messaging_group_agents DROP COLUMN response_scope;
      `);
    }

    log.info('engage-modes migration: backfilled rows', { count: rows.length });
  },
};
