/** Identifier rules for the remote mailbox wire protocol. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface RemoteSessionKey {
  agentGroupId: string;
  sessionId: string;
}

export function isSafeMailboxId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function isValidSessionKey(key: unknown): key is RemoteSessionKey {
  if (typeof key !== 'object' || key === null) return false;
  const { agentGroupId, sessionId } = key as Record<string, unknown>;
  return isSafeMailboxId(agentGroupId) && isSafeMailboxId(sessionId);
}

/** Parse the `x-nanoclaw-session` header (`<agentGroupId>/<sessionId>`). */
export function parseSessionHeader(value: unknown): RemoteSessionKey | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('/');
  if (parts.length !== 2) return null;
  const [agentGroupId, sessionId] = parts;
  return isSafeMailboxId(agentGroupId) && isSafeMailboxId(sessionId) ? { agentGroupId, sessionId } : null;
}

/** A plain basename: no separators or NUL, not `.`/`..`, no leading dot. */
export function isSafeOutboxFilename(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[^/\\\0]{1,255}$/.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.startsWith('.')
  );
}
