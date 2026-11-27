import type { Migration } from './index.js';

/**
 * Each conversation's top-level talk, recorded as the Host sees it, for the
 * session backfill (src/modules/cross-session-context/timeline.ts): a
 * session's root user message and its top-level agent posts. The backfill
 * reads these rows instead of opening each sibling session's mailbox.
 * No foreign key, like the host-coordination tables: a deleted session's rows
 * are cleared where the session is deleted.
 */
export const migration027: Migration = {
  version: 27,
  name: 'conversation-timeline',
  async up(db) {
    await db.exec(`
      CREATE TABLE conversation_timeline (
        id TEXT PRIMARY KEY,
        agent_group_id TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        sender TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        text TEXT NOT NULL,
        self INTEGER NOT NULL,
        platform_message_id TEXT
      );
      CREATE INDEX idx_conversation_timeline_conversation
        ON conversation_timeline(agent_group_id, messaging_group_id, timestamp);
      CREATE INDEX idx_conversation_timeline_session ON conversation_timeline(session_id);
    `);
  },
};
