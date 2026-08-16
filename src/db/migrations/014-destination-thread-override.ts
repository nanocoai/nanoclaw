import type { Migration } from './index.js';

/**
 * Add thread_id_override to agent_destinations.
 *
 * When set, the container's sendToDestination uses this value instead of
 * resolving the thread from the most recent inbound message. Empty string
 * means "post to channel directly (no thread)"; a full discord thread ID
 * (e.g. "discord:guildId:channelId:threadId") pins all outbound messages
 * from this agent to that specific thread.
 */
export const migration014: Migration = {
  version: 14,
  name: 'destination-thread-override',
  up(db) {
    db.exec(`ALTER TABLE agent_destinations ADD COLUMN thread_id_override TEXT`);
  },
};
