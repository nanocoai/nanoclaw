/** Shared helpers for the remote mailbox tests: a real session directory with real schemas. */
import fs from 'fs';

import type { InboundWrite } from '../model.js';
import { inboundDbPath, outboundDbPath, sessionMailboxDir } from '../sqlite/paths.js';
import { ensureSchema, insertMessage, openInboundDb } from '../sqlite/session-db.js';
import type { RemoteSessionKey } from './ids.js';

export function createTestSession(agentGroupId = 'ag-test', sessionId = 'sess-test') {
  const key: RemoteSessionKey = { agentGroupId, sessionId };
  const dir = sessionMailboxDir(key);
  fs.mkdirSync(dir, { recursive: true });
  ensureSchema(inboundDbPath(agentGroupId, sessionId), 'inbound');
  ensureSchema(outboundDbPath(agentGroupId, sessionId), 'outbound');
  return { key, dir };
}

/** Host-side inbound write through the host's own API. Returns the allocated (even) seq via the row. */
export function hostInsert(key: RemoteSessionKey, overrides: Partial<InboundWrite> & { id: string }): void {
  const db = openInboundDb(inboundDbPath(key.agentGroupId, key.sessionId));
  try {
    insertMessage(db, {
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: 'plat-1',
      channelType: 'test',
      threadId: null,
      content: '{"text":"hi"}',
      processAfter: null,
      recurrence: null,
      ...overrides,
    });
  } finally {
    db.close();
  }
}
