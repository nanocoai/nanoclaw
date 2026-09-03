import type { AgentMailbox, AgentMailboxFactory } from './types.js';

const SESSION_CONTEXT = '/app/.nanoclaw-session.json';

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

export async function readMailboxContext(
  contextPath = SESSION_CONTEXT,
): Promise<import('./types.js').MailboxSessionKey | null> {
  // A host that predates the mailbox seam spawns containers without the
  // context file (agent-runner source is a shared read-only mount, so the
  // runner updates before the host process restarts). The SQLite fallback
  // never reads the context, so degrade gracefully instead of crash-looping
  // every container until the operator restarts the service.
  if (!(await Bun.file(contextPath).exists())) {
    console.error('[mailbox] No session context file — assuming pre-seam host');
    return null;
  }
  let value: unknown;
  try {
    value = await Bun.file(contextPath).json();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') {
      console.error('[mailbox] Session context is unreadable — assuming pre-seam host');
      return null;
    }
    throw error;
  }
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as Record<string, unknown>).agentGroupId !== 'string' ||
    (value as Record<string, unknown>).agentGroupId === '' ||
    typeof (value as Record<string, unknown>).sessionId !== 'string' ||
    (value as Record<string, unknown>).sessionId === '' ||
    !('mailbox' in value)
  ) {
    throw new Error('Invalid NanoClaw session context');
  }
  return value as import('./types.js').MailboxSessionKey;
}

export type {
  AgentMailbox,
  AgentMailboxFactory,
  Destination,
  InboundMessage,
  MailboxSessionKey,
  MailboxOperations,
  OutboundMessage,
  OutboundMessageDraft,
  SessionRouting,
  StateValue,
} from './types.js';
