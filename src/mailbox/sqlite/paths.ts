import path from 'path';

import { DATA_DIR } from '../../config.js';
import type { MailboxSessionKey } from '../types.js';

export function sessionMailboxDir(key: MailboxSessionKey): string {
  return path.join(DATA_DIR, 'v2-sessions', key.agentGroupId, key.sessionId);
}

export function sessionMailboxPath(key: MailboxSessionKey, side: 'inbound' | 'outbound'): string {
  return path.join(sessionMailboxDir(key), `${side}.db`);
}

export function inboundDbPath(agentGroupId: string, sessionId: string): string {
  return sessionMailboxPath({ agentGroupId, sessionId }, 'inbound');
}

export function outboundDbPath(agentGroupId: string, sessionId: string): string {
  return sessionMailboxPath({ agentGroupId, sessionId }, 'outbound');
}
