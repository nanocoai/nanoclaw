/**
 * Replace `trigger_rules` (opaque JSON) + `response_scope` (conflated axis)
 * with four explicit orthogonal columns on messaging_group_agents:
 *
 *   engage_mode            'pattern' | 'mention' | 'mention-sticky'
 *   engage_pattern         regex string (required when engage_mode='pattern';
 *                          '.' means "match everything" — the "always" flavor)
 *   sender_scope           'all' | 'known'
 *   ignored_message_policy 'drop' | 'accumulate'
 *
 * Backfill rules (applied per-row, reading the old JSON):
 *   - If trigger_rules.pattern is a non-empty string → engage_mode='pattern',
 *     engage_pattern = that value
 *   - Else if trigger_rules.requiresTrigger === false OR response_scope='all'
 *     → engage_mode='pattern', engage_pattern='.'
 *   - Else (requires trigger but no pattern specified) → engage_mode='mention'
 *   - sender_scope: 'known' when response_scope was 'allowlisted', 'all' otherwise
 *   - ignored_message_policy: 'drop' (conservative default; no old-schema analog)
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

import { log } from '../../log.js';

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
  sqliteOnly: true,
  up: (db: Database.Database) => {
    // Add the four new columns alongside the existing two. SQLite ALTER ADD
    // is cheap and non-rewriting.
    db.exec(`
      ALTER TABLE messaging_group_agents ADD COLUMN engage_mode            TEXT;
      ALTER TABLE messaging_group_agents ADD COLUMN engage_pattern         TEXT;
      ALTER TABLE messaging_group_agents ADD COLUMN sender_scope           TEXT;
      ALTER TABLE messaging_group_agents ADD COLUMN ignored_message_policy TEXT;
    `);

    // Backfill existing rows in JS (parsing JSON per-row is painful in pure SQL).
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

    // Drop the legacy columns. DROP COLUMN requires SQLite 3.35+ (2021); our
    // better-sqlite3 ships a current build.
    db.exec(`
      ALTER TABLE messaging_group_agents DROP COLUMN trigger_rules;
      ALTER TABLE messaging_group_agents DROP COLUMN response_scope;
    `);

    log.info('engage-modes migration: backfilled rows', { count: rows.length });
  },
};
