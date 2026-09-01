import type { MailboxOperations, OutboundMessageDraft, ProcessingStatus } from '../../mailbox/types.js';
import type {
  ContainerRecord,
  DeliveryRecord,
  DestinationRecord,
  InboundRecord,
  OutboundRecord,
  ProcessingAckRecord,
  SessionRoutingRecord,
  StateRecord,
} from '../../mailbox/model.generated.js';
import { parseIsoTimestamp } from '../../mailbox/model.generated.js';

export interface InboundData {
  messages: Map<string, InboundRecord>;
  deliveries: Map<string, DeliveryRecord>;
  destinations: Map<string, DestinationRecord>;
  routing: Map<string, SessionRoutingRecord>;
}

export interface OutboundData {
  messages: Map<string, OutboundRecord>;
  acknowledgements: Map<string, ProcessingAckRecord>;
  state: Map<string, StateRecord>;
  container: Map<string, ContainerRecord>;
}

function due(value: string | null): boolean {
  if (value === null) return true;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

export function createMailboxOperations(
  inbound: InboundData,
  outbound: OutboundData,
  writeMessageOut: (message: OutboundMessageDraft) => Promise<number>,
): MailboxOperations {
  const markMessages = (ids: string[], status: ProcessingStatus): void => {
    const statusChanged = parseIsoTimestamp(new Date().toISOString());
    for (const messageId of ids)
      outbound.acknowledgements.set(messageId, {
        messageId,
        status,
        statusChanged,
      });
  };

  return {
    getPendingMessages: (limit, isFirstPoll) => {
      const acked = new Set(outbound.acknowledgements.keys());
      const pending = [...inbound.messages.values()]
        .filter(
          (message) =>
            message.status === 'pending' &&
            due(message.processAfter) &&
            (!message.onWake || isFirstPoll) &&
            !acked.has(message.id),
        )
        .sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0));
      const batch = pending.slice(0, limit);
      if (batch.length > 0 && !batch.some(({ trigger }) => trigger)) {
        const rescue = pending.slice(limit).find(({ trigger }) => trigger);
        if (rescue) batch.push(rescue);
      }
      return batch.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    },
    markMessages,
    markScriptSkipped: (skips) => {
      for (const skip of skips) markMessages([skip.id], skip.reason === 'error' ? 'script-skip:error' : 'completed');
    },
    getMessageIn: (id) => inbound.messages.get(id),
    findQuestionResponse: (questionId) => {
      const response = [...inbound.messages.values()].find(
        (message) => message.status === 'pending' && message.content.includes(`"questionId":"${questionId}"`),
      );
      return response && !outbound.acknowledgements.has(response.id) ? response : undefined;
    },
    findCliResponse: (requestId) =>
      [...inbound.messages.values()].find(
        (message) => message.status === 'pending' && message.content.includes(`"requestId":"${requestId}"`),
      ),
    writeMessageOut,
    getMessageIdBySeq: (sequence) => {
      const incoming = [...inbound.messages.values()].find((message) => message.sequence === sequence);
      if (incoming) return incoming.id;
      const outgoing = [...outbound.messages.values()].find((message) => message.sequence === sequence);
      if (!outgoing) return null;
      return inbound.deliveries.get(outgoing.id)?.platformMessageId ?? outgoing.id;
    },
    getRoutingBySeq: (sequence) => {
      const message =
        [...inbound.messages.values()].find((row) => row.sequence === sequence) ??
        [...outbound.messages.values()].find((row) => row.sequence === sequence);
      return message
        ? {
            channelType: message.channelType,
            platformId: message.platformId,
            threadId: message.threadId,
          }
        : null;
    },
    getLatestInboundRoute: (channelType, platformId) => {
      const message = [...inbound.messages.values()]
        .filter((row) => row.channelType === channelType && row.platformId === platformId)
        .sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0))[0];
      return message ? { threadId: message.threadId, inReplyTo: message.id } : null;
    },
    getUndeliveredMessages: () =>
      [...outbound.messages.values()]
        .filter((message) => due(message.deliverAfter))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    getState: (key) => {
      const state = outbound.state.get(key);
      return state && { value: state.value, updatedAt: state.updatedAt };
    },
    setState: (key, value) =>
      outbound.state.set(key, {
        key,
        value,
        updatedAt: parseIsoTimestamp(new Date().toISOString()),
      }),
    deleteState: (key) => {
      outbound.state.delete(key);
    },
    getSessionRouting: () => {
      const routing = inbound.routing.get('routing');
      return routing
        ? {
            channelType: routing.channelType,
            platformId: routing.platformId,
            threadId: routing.threadId,
          }
        : { channelType: null, platformId: null, threadId: null };
    },
    getDestinations: () => [...inbound.destinations.values()].sort((a, b) => a.name.localeCompare(b.name)),
    findDestinationByName: (name) => inbound.destinations.get(name),
    findDestinationByRouting: (channelType, platformId) =>
      [...inbound.destinations.values()].find((destination) =>
        channelType === 'agent'
          ? destination.type === 'agent' && destination.agentGroupId === platformId
          : destination.type === 'channel' &&
            destination.channelType === channelType &&
            destination.platformId === platformId,
      ),
    setContainerToolInFlight: (tool, declaredTimeoutMs) => {
      const now = parseIsoTimestamp(new Date().toISOString());
      outbound.container.set('container', {
        currentTool: tool,
        toolDeclaredTimeoutMs: declaredTimeoutMs,
        toolStartedAt: now,
        updatedAt: now,
      });
    },
    clearContainerToolInFlight: () =>
      outbound.container.set('container', {
        currentTool: null,
        toolDeclaredTimeoutMs: null,
        toolStartedAt: null,
        updatedAt: parseIsoTimestamp(new Date().toISOString()),
      }),
    clearStaleProcessingAcks: () => {
      for (const ack of outbound.acknowledgements.values()) {
        if (ack.status === 'processing') outbound.acknowledgements.delete(ack.messageId);
      }
    },
    ...ackRelease(outbound),
  };
}

/**
 * Named claims handed back, so the rows become fetchable again. Same deletion
 * as `clearStaleProcessingAcks`, narrowed to the ids the caller is releasing:
 * an ack in any other status is a decision this must not undo.
 *
 * SPREAD, not written inline, because this operation is on
 * `MailboxOperations` only where the code runner is composed —
 * `skills/code-mode` graduates it onto the interface. A recipe that carries
 * this skill WITHOUT code mode has no such member, and an inline property
 * would be an excess-property error there; a spread of a typed value is
 * assignable either way. Implement it unconditionally regardless: it is this
 * store's own ack lifecycle, and a store that silently could not give a claim
 * back would drop mail at every code-runner life boundary.
 */
function ackRelease(outbound: OutboundData): { releaseProcessingClaims: (ids: string[]) => void } {
  return {
    releaseProcessingClaims: (ids) => {
      for (const messageId of ids) {
        if (outbound.acknowledgements.get(messageId)?.status === 'processing')
          outbound.acknowledgements.delete(messageId);
      }
    },
  };
}
