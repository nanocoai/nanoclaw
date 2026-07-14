import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Pilot activation codes — the shellano pilot's Telegram-first onboarding.
 *
 * POST /api/register creates a row (status='pending') and hands the lead a
 * t.me deep link. When the user presses START in Telegram, the code is
 * consumed (status='used') and the agent binds to the presser's Telegram
 * identity. Phone/email from the form live in `metadata` — contact info
 * only, never a routing key.
 */
export const migration016: Migration = {
  version: 16,
  name: 'pilot-activations',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pilot_activations (
        code            TEXT PRIMARY KEY,
        lang            TEXT NOT NULL DEFAULT 'he',
        metadata        TEXT,
        created_at      TEXT NOT NULL,
        expires_at      TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        used_by_user_id TEXT,
        used_at         TEXT,
        agent_group_id  TEXT,
        pilot_started_at TEXT,
        pilot_ends_at   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pilot_activations_user ON pilot_activations(used_by_user_id);
    `);
  },
};
