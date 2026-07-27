/**
 * Per-batch context the poll loop publishes for downstream consumers
 * (MCP tools, etc.) that don't sit on the poll-loop's call stack.
 *
 * Today the only field is `inReplyTo` — the id of the first inbound
 * message in the batch the agent is currently processing. MCP tools like
 * `send_message` and `send_file` read this and stamp it onto the outbound
 * row so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * This is module-level state on purpose: the agent-runner is single-process
 * and processes one batch at a time. Poll-loop calls `setCurrentInReplyTo`
 * before invoking the provider and `clearCurrentInReplyTo` after the batch
 * completes (or errors out).
 */
export interface CurrentBatchRouting {
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
}

let currentInReplyTo: string | null = null;
let currentRouting: CurrentBatchRouting | null = null;

/**
 * Publish the routing of the batch's triggering message so `send_message`
 * (and friends) can default a reply to the exact chat that message came
 * from, instead of the session's sticky first-channel routing.
 */
export function setCurrentRouting(routing: CurrentBatchRouting | null): void {
  currentRouting = routing;
}

export function getCurrentRouting(): CurrentBatchRouting | null {
  return currentRouting;
}

export function setCurrentInReplyTo(id: string | null): void {
  currentInReplyTo = id;
}

export function clearCurrentInReplyTo(): void {
  currentInReplyTo = null;
}

export function getCurrentInReplyTo(): string | null {
  return currentInReplyTo;
}

