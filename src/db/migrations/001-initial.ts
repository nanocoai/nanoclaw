import type { Migration } from './index.js';
import { colId, colLongText, colText, tableSuffix, type MigrationContext } from './helpers.js';
import type { ICentralDb } from '../central/types.js';

export const migration001: Migration = {
  version: 1,
  name: 'initial-v2-schema',
  up(db: ICentralDb, ctx: MigrationContext) {
    const id = colId(ctx);
    const txt = colText(ctx);
    const long = colLongText(ctx);
    const t = tableSuffix(ctx);
    db.exec(`
      CREATE TABLE agent_groups (
        id               ${id} PRIMARY KEY,
        name             ${txt} NOT NULL,
        folder           ${txt} NOT NULL UNIQUE,
        agent_provider   ${txt},
        created_at       ${txt} NOT NULL
      )${t};

      CREATE TABLE messaging_groups (
        id                    ${id} PRIMARY KEY,
        channel_type          ${txt} NOT NULL,
        platform_id           ${txt} NOT NULL,
        name                  ${txt},
        is_group              INTEGER DEFAULT 0,
        unknown_sender_policy ${txt} NOT NULL DEFAULT 'strict',
        created_at            ${txt} NOT NULL,
        UNIQUE(channel_type, platform_id)
      )${t};

      CREATE TABLE messaging_group_agents (
        id                 ${id} PRIMARY KEY,
        messaging_group_id ${id} NOT NULL REFERENCES messaging_groups(id),
        agent_group_id     ${id} NOT NULL REFERENCES agent_groups(id),
        trigger_rules      ${long},
        response_scope     ${txt} DEFAULT 'all',
        session_mode       ${txt} DEFAULT 'shared',
        priority           INTEGER DEFAULT 0,
        created_at         ${txt} NOT NULL,
        UNIQUE(messaging_group_id, agent_group_id)
      )${t};

      CREATE TABLE users (
        id           ${id} PRIMARY KEY,
        kind         ${txt} NOT NULL,
        display_name ${txt},
        created_at   ${txt} NOT NULL
      )${t};

      CREATE TABLE user_roles (
        user_id        ${id} NOT NULL REFERENCES users(id),
        role           ${txt} NOT NULL,
        agent_group_id ${id} REFERENCES agent_groups(id),
        granted_by     ${id} REFERENCES users(id),
        granted_at     ${txt} NOT NULL,
        PRIMARY KEY (user_id, role, agent_group_id)
      )${t};
      CREATE INDEX idx_user_roles_scope ON user_roles(agent_group_id, role);

      CREATE TABLE agent_group_members (
        user_id        ${id} NOT NULL REFERENCES users(id),
        agent_group_id ${id} NOT NULL REFERENCES agent_groups(id),
        added_by       ${id} REFERENCES users(id),
        added_at       ${txt} NOT NULL,
        PRIMARY KEY (user_id, agent_group_id)
      )${t};

      CREATE TABLE user_dms (
        user_id            ${id} NOT NULL REFERENCES users(id),
        channel_type       ${txt} NOT NULL,
        messaging_group_id ${id} NOT NULL REFERENCES messaging_groups(id),
        resolved_at        ${txt} NOT NULL,
        PRIMARY KEY (user_id, channel_type)
      )${t};

      CREATE TABLE sessions (
        id                 ${id} PRIMARY KEY,
        agent_group_id     ${id} NOT NULL REFERENCES agent_groups(id),
        messaging_group_id ${id} REFERENCES messaging_groups(id),
        thread_id          ${txt},
        agent_provider     ${txt},
        status             ${txt} DEFAULT 'active',
        container_status   ${txt} DEFAULT 'stopped',
        last_active        ${txt},
        created_at         ${txt} NOT NULL
      )${t};
      CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
      CREATE INDEX idx_sessions_lookup ON sessions(messaging_group_id, thread_id);

      CREATE TABLE pending_questions (
        question_id    ${id} PRIMARY KEY,
        session_id     ${id} NOT NULL REFERENCES sessions(id),
        message_out_id ${id} NOT NULL,
        platform_id    ${txt},
        channel_type   ${txt},
        thread_id      ${txt},
        title          ${txt} NOT NULL,
        options_json   ${long} NOT NULL,
        created_at     ${txt} NOT NULL
      )${t};
    `);
  },
};
