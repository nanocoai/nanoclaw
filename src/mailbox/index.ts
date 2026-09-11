import type { AgentMailbox, AgentMailboxFactory } from './types.js';

let active: AgentMailbox | undefined;
let factory: AgentMailboxFactory | undefined;

export function getAgentMailbox(): AgentMailbox {
  if (!factory) throw new Error('No agent mailbox registered');
  return (active ??= factory());
}

export function registerAgentMailbox(next: AgentMailboxFactory): void {
  if (factory || active) throw new Error('Agent mailbox already registered');
  factory = next;
}

export function resetAgentMailboxForTesting(): AgentMailboxFactory | undefined {
  const previous = factory;
  active = undefined;
  factory = undefined;
  return previous;
}

export type {
  AgentMailbox,
  AgentMailboxFactory,
  ContainerState,
  Destination,
  DirectOutboundMessage,
  InboundMessage,
  InboundMailbox,
  MailboxSessionKey,
  MailboxSession,
  MessageRetry,
  OutboundMessage,
  OutboundMailbox,
  ProcessingClaim,
  ProcessingAck,
  RecurringMessage,
  SessionRouting,
  Task,
  TaskRecord,
  TaskStats,
  TaskUpdate,
} from './types.js';
