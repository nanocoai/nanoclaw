/**
 * Delivery action handler for CLI requests from container agents.
 *
 * When an agent writes a `cli_request` system message to outbound.db,
 * the delivery poll picks it up and calls this handler. We dispatch
 * the command and write the response back to inbound.db.
 */
import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../delivery.js';
import { unguarded } from '../guard/index.js';
import { insertMessage } from '../db/session-db.js';
import { log } from '../log.js';
import { dispatch } from './dispatch.js';
import type { RequestFrame } from './frame.js';
import type { Session } from '../types.js';

registerDeliveryAction(
  'cli_request',
  async (content, session, inDb) => {
    const requestId = content.requestId as string;
    const command = content.command as string;
    const args = (content.args as Record<string, unknown>) ?? {};

    if (!requestId || !command) {
      log.warn('cli_request missing requestId or command', { sessionId: session.id });
      return;
    }

    const req: RequestFrame = { id: requestId, command, args };
    const ctx = {
      caller: 'agent' as const,
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      messagingGroupId: session.messaging_group_id ?? '',
    };

    log.info('CLI request from agent', { requestId, command, sessionId: session.id });

    const response = await dispatch(req, ctx);

    // Write response to inbound.db so the container can read it.
    // trigger=0: don't wake the agent — this is an inline response to a tool call.
    insertMessage(inDb, {
      id: `cli-resp-${requestId}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({
        type: 'cli_response',
        requestId,
        frame: response,
      }),
      processAfter: null,
      recurrence: null,
      trigger: 0,
    });

    log.info('CLI response written', { requestId, ok: response.ok, sessionId: session.id });
  },
  unguarded('transport envelope — every inner command is guarded at dispatch'),
);
