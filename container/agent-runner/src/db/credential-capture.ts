/**
 * Tracks an in-progress agent-browser credential-vault setup for THIS
 * session — at most one at a time. The poll loop (poll-loop.ts) checks this
 * on every inbound message and, while a capture is pending, intercepts the
 * reply itself instead of ever turning it into an LLM prompt. See
 * request_credential_setup in mcp-tools/bureaucracy-automation.ts.
 */
import { getAgentMailbox } from '../mailbox/index.js';

const STATE_KEY = 'pending_credential_capture';

export interface PendingCredentialCapture {
  site: string;
  url: string;
  step: 'username' | 'password';
  /** Set once the username step completes; carried into the password step. */
  username?: string;
}

export function getPendingCredentialCapture(): PendingCredentialCapture | undefined {
  const raw = getAgentMailbox().operations.getState(STATE_KEY)?.value;
  return raw ? (JSON.parse(raw) as PendingCredentialCapture) : undefined;
}

export function setPendingCredentialCapture(state: PendingCredentialCapture): void {
  getAgentMailbox().operations.setState(STATE_KEY, JSON.stringify(state));
}

export function clearPendingCredentialCapture(): void {
  getAgentMailbox().operations.deleteState(STATE_KEY);
}
