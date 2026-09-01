/** Durable terminal-task transition and occurrence-scoped evidence. */
import type { InboundMailbox, OutboundMailbox } from '../mailbox/index.js';
import type { Session } from '../types.js';

import { emitTaskRun } from './runtime-emitters.js';
import type { TaskRunActivity } from './activity-mappers.js';

/**
 * Apply every terminal runner acknowledgement, then report only exact task
 * occurrences that this call durably transitioned. Series-aware task lookup
 * may resolve a newer recurring occurrence, so occurrence id equality is the
 * evidence boundary.
 */
export async function applyTerminalTaskEvidence(
  mailbox: InboundMailbox & OutboundMailbox,
  session: Pick<Session, 'id' | 'agent_group_id'>,
): Promise<void> {
  const terminalAcks = mailbox.getTerminalProcessingAcks();
  const terminalTasks = terminalAcks.flatMap((ack): TaskRunActivity[] => {
    const task = mailbox.getTask(ack.messageId);
    if (
      !task ||
      task.id !== ack.messageId ||
      task.status === 'completed' ||
      task.status === 'failed'
    ) {
      return [];
    }
    return [{
      agentId: session.agent_group_id,
      sessionId: session.id,
      seriesId: task.seriesId ?? task.id,
      activityId: task.id,
      outcome: ack.status === 'completed' ? 'success' : 'failure',
    }];
  });

  mailbox.applyProcessingAcks(terminalAcks);
  for (const task of terminalTasks) await emitTaskRun(task);
}
