/**
 * Delivery action handler for CLI requests from container agents.
 *
 * When an agent writes a `cli_request` system message to its outbound mailbox,
 * the delivery poll picks it up and calls this handler. We dispatch
 * the command and write the response back to its inbound mailbox.
 */
import { registerDeliveryAction } from '../delivery.js';
import { unguarded } from '../guard/index.js';
import { log } from '../log.js';
import { writeSessionMessage } from '../session-manager.js';
import { dispatch } from './dispatch.js';
import type { RequestFrame } from './frame.js';

registerDeliveryAction(
  'cli_request',
  async (content, session) => {
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

    // Write the response to the inbound mailbox so the runner can read it.
    // Don't wake the agent — this is an inline response to a tool call.
    // Opens its own mailbox session — dispatch() above may already have opened
    // (and closed) sessions on this key; nothing here holds one across calls.
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `cli-resp-${requestId}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({
        type: 'cli_response',
        requestId,
        frame: response,
      }),
      trigger: false,
    });

    log.info('CLI response written', { requestId, ok: response.ok, sessionId: session.id });
  },
  unguarded('transport envelope — every inner command is guarded at dispatch'),
);
