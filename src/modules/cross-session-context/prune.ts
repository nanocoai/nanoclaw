/**
 * Host-sweep pruner for cross-session echo backlogs.
 *
 * Pending trigger=0 rows have no other TTL. Only pending echo rows are
 * touched; delivered context is history, not backlog.
 */
import { ECHO_BACKLOG_CAP, ECHO_CHANNEL_TYPE, ECHO_MAX_AGE_DAYS } from './config.js';

type PrunableMailbox = {
  prunePendingMessages(channelType: string, before: string, keep: number): number;
};

/**
 * Prune pending session-echo rows in one mailbox:
 *   1. drop rows older than ECHO_MAX_AGE_DAYS,
 *   2. keep only the newest ECHO_BACKLOG_CAP by seq.
 * Returns the number of rows deleted.
 */
export function pruneEchoBacklog(mailbox: PrunableMailbox, opts: { now?: number } = {}): number {
  const keep = ECHO_BACKLOG_CAP;
  const cutoffIso = new Date((opts.now ?? Date.now()) - ECHO_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return mailbox.prunePendingMessages(ECHO_CHANNEL_TYPE, cutoffIso, keep);
}
