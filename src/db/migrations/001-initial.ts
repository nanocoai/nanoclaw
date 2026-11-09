import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration001: Migration = {
  version: 1,
  name: 'initial-v2-schema',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE agent_groups (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        folder           TEXT NOT NULL UNIQUE,
        agent_provider   TEXT,
        created_at       TEXT NOT NULL
      );

      CREATE TABLE messaging_groups (
        id                    TEXT PRIMARY KEY,
        channel_type          TEXT NOT NULL,
        platform_id           TEXT NOT NULL,
        name                  TEXT,
        is_group              INTEGER DEFAULT 0,
        unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
        created_at            TEXT NOT NULL,
        UNIQUE(channel_type, platform_id)
      );

      CREATE TABLE messaging_group_agents (
        id                 TEXT PRIMARY KEY,
        messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
        agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
        trigger_rules      TEXT,
        response_scope     TEXT DEFAULT 'all',
        session_mode       TEXT DEFAULT 'shared',
        priority           INTEGER DEFAULT 0,
        created_at         TEXT NOT NULL,
        UNIQUE(messaging_group_id, agent_group_id)
      );

      CREATE TABLE users (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        display_name TEXT,
        created_at   TEXT NOT NULL
      );

      -- role ∈ {owner, admin}
      -- owner: agent_group_id must be NULL (always global)
      -- admin: agent_group_id NULL = global, else scoped
      CREATE TABLE user_roles (
        user_id        TEXT NOT NULL REFERENCES users(id),
        role           TEXT NOT NULL,
        agent_group_id TEXT REFERENCES agent_groups(id),
        granted_by     TEXT REFERENCES users(id),
        granted_at     TEXT NOT NULL,
        PRIMARY KEY (user_id, role, agent_group_id)
      );
      CREATE INDEX idx_user_roles_scope ON user_roles(agent_group_id, role);

      -- "known" membership in an agent group. Admin @ A implies membership
      -- without needing a row (invariant enforced in code).
      CREATE TABLE agent_group_members (
        user_id        TEXT NOT NULL REFERENCES users(id),
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        added_by       TEXT REFERENCES users(id),
        added_at       TEXT NOT NULL,
        PRIMARY KEY (user_id, agent_group_id)
      );

      -- DM channel cache: for each (user, channel) pair, which messaging_group
      -- row is their direct-message channel. Populated on demand by
      -- ensureUserDm() — either from adapter.openDM() for channels that
      -- distinguish user id from DM chat id (Discord, Slack, Teams) or by
      -- pointing directly at the user's handle for channels where they're
      -- the same (Telegram, WhatsApp, iMessage, email, Matrix).
      CREATE TABLE user_dms (
        user_id            TEXT NOT NULL REFERENCES users(id),
        channel_type       TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
        resolved_at        TEXT NOT NULL,
        PRIMARY KEY (user_id, channel_type)
      );

      CREATE TABLE sessions (
        id                 TEXT PRIMARY KEY,
        agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
        messaging_group_id TEXT REFERENCES messaging_groups(id),
        thread_id          TEXT,
        agent_provider     TEXT,
        status             TEXT DEFAULT 'active',
        container_status   TEXT DEFAULT 'stopped',
        last_active        TEXT,
        created_at         TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
      CREATE INDEX idx_sessions_lookup ON sessions(messaging_group_id, thread_id);

      CREATE TABLE pending_questions (
        question_id    TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL REFERENCES sessions(id),
        message_out_id TEXT NOT NULL,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        title          TEXT NOT NULL,
        options_json   TEXT NOT NULL,
        created_at     TEXT NOT NULL
      );
    `);
  },
};
