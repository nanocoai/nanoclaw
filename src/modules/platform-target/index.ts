/**
 * Translate an agent-facing message id back to the platform's own id.
 *
 * An agent never sees a raw platform message id for an INBOUND message. The
 * router namespaces it — `messageIdForAgent` returns `<id>:<agent group id>`
 * so that one message fanned out to several agents keeps a unique primary key
 * per session. That is correct for storage and wrong for the wire: an
 * operation that targets a message the person sent, like a reaction, is
 * handed straight to the platform, which has never heard of the suffix.
 *
 * Slack answers `message_not_found`, delivery retries three times and drops
 * it, and the person simply never sees the reaction (nancy-v3, 2026-09-01).
 *
 * Only the suffix this session owns is removed, and only when it is exactly
 * `:<agentGroupId>` at the end. An id that legitimately contains a colon — a
 * platform id from our own delivery record, say — is returned untouched, so
 * edits of the agent's own messages keep working.
 */

/** Operations whose `messageId` addresses a message the AGENT received. */
const AGENT_ADDRESSED_OPERATIONS = new Set(['reaction']);

/** Strip the agent-group namespace the router added, if this id carries it. */
export function platformMessageId(messageId: string, agentGroupId: string): string {
  if (!agentGroupId) return messageId;
  const suffix = `:${agentGroupId}`;
  return messageId.endsWith(suffix) ? messageId.slice(0, -suffix.length) : messageId;
}

/**
 * Rewrite an outbound content blob so platform-addressed operations carry the
 * platform's id. Returns the input unchanged for anything it does not
 * recognise — malformed JSON, a different operation, an id without the
 * namespace — because this sits on the delivery path and must never be the
 * reason a message fails to send.
 */
export function platformTargetContent(content: string, agentGroupId: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return content;
    const blob = parsed as Record<string, unknown>;
    const operation = blob.operation;
    const messageId = blob.messageId;
    if (typeof operation !== 'string' || !AGENT_ADDRESSED_OPERATIONS.has(operation)) return content;
    if (typeof messageId !== 'string' || messageId.length === 0) return content;
    const translated = platformMessageId(messageId, agentGroupId);
    if (translated === messageId) return content;
    return JSON.stringify({ ...blob, messageId: translated });
  } catch {
    return content;
  }
}
