// Generic poll-loop extension seam (Route-C hook). INERT on pristine core: with
// no registrant, every apply* returns its input unchanged, so the poll loop
// behaves byte-identically to upstream. An overlay may register hooks that
// transform the pending-message batch or the turn lifecycle. This module holds
// the poll-loop registries (one per extraction); each is independently inert.
//
// First registry (cluster 5, #387 runner-gating): a message filter applied to
// the pending batch right after it is read from getPendingMessages — e.g. a
// state-gated suppression of scheduled-runner (standup/digest/review) messages
// when the board is idle/stale. Composed left-to-right in registration order.
import type { MessageInRow } from './db/messages-in.js';

export type MessageFilter = (messages: MessageInRow[]) => MessageInRow[];

const messageFilters: MessageFilter[] = [];

export function registerMessageFilter(fn: MessageFilter): void {
  messageFilters.push(fn);
}

/** Left-fold over registrants. No registrant ⇒ returns `messages` unchanged. */
export function applyMessageFilter(messages: MessageInRow[]): MessageInRow[] {
  return messageFilters.reduce((acc, fn) => fn(acc), messages);
}

export function __resetMessageFilterForTest(): void {
  messageFilters.length = 0;
}
