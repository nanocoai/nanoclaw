/**
 * Agent mailbox that reaches the host's session DBs over HTTP instead of a
 * mounted SQLite file. Wire contract: the remote-mailbox spec (POST
 * /v1/mailbox, positional args, null-for-undefined results).
 */
import fs from 'node:fs';

import type {
  AgentMailbox,
  Destination,
  InboundMessage,
  MailboxOperations,
  MailboxSessionKey,
  OutboundMessage,
  OutboundMessageDraft,
  ProcessingStatus,
  SessionRouting,
  StateValue,
} from '../types.js';
import { type RpcCall, syncInbox, uploadOutbox } from './files.js';
import { MailboxAuthError, MailboxRpcError, SyncRpcClient, type CallOptions, type SyncRpcOptions } from './sync-rpc.js';

export { MailboxAuthError, MailboxRpcError, SyncRpcClient } from './sync-rpc.js';

const SESSION_CONTEXT = '/app/.nanoclaw-session.json';

export interface RemoteMailboxOptions extends Partial<SyncRpcOptions> {
  url: string;
  token: string;
  /** `<agentGroupId>/<sessionId>`. Defaults to NANOCLAW_MAILBOX_SESSION, then the session context file. */
  session?: string;
  inboxRoot?: string;
  outboxRoot?: string;
  contextPath?: string;
  /**
   * Timeout for read-only poll calls (getPendingMessages). Shorter than the
   * per-call default so a call in flight when the host restarts (reply lost
   * behind OpenShell's proxy) is abandoned quickly; the next poll re-reads.
   * Writes and file transfer keep the longer default.
   */
  readTimeoutMs?: number;
  /** Test seam: share an existing client instead of creating one. */
  client?: SyncRpcClient;
}

const DEFAULT_READ_TIMEOUT_MS = 3_000;

const undef = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

export class RemoteAgentMailbox implements AgentMailbox, MailboxOperations {
  readonly operations: MailboxOperations = this;
  private readonly client: SyncRpcClient;
  private readonly inboxRoot: string;
  private readonly outboxRoot: string;

  constructor(private readonly options: RemoteMailboxOptions) {
    this.client = options.client ?? new SyncRpcClient(options);
    this.inboxRoot = options.inboxRoot ?? '/workspace/inbox';
    this.outboxRoot = options.outboxRoot ?? '/workspace/outbox';
  }

  private readonly rpc: RpcCall = <T>(op: string, args: unknown[] = []): T => this.call<T>(op, args);

  private call<T>(op: string, args: unknown[], options?: CallOptions): T {
    if (!this.client.session) this.client.session = this.resolveSession();
    return this.client.call<T>(op, args, options);
  }

  private resolveSession(): string {
    if (this.options.session) return this.options.session;
    if (process.env.NANOCLAW_MAILBOX_SESSION) return process.env.NANOCLAW_MAILBOX_SESSION;
    try {
      const context = JSON.parse(fs.readFileSync(this.options.contextPath ?? SESSION_CONTEXT, 'utf8'));
      if (typeof context.agentGroupId === 'string' && typeof context.sessionId === 'string') {
        return `${context.agentGroupId}/${context.sessionId}`;
      }
    } catch {
      // fall through
    }
    throw new MailboxRpcError('no_session', 'cannot determine mailbox session identity');
  }

  shouldRestartAfter(error: unknown): boolean {
    return error instanceof MailboxAuthError;
  }

  async start(contextKey: MailboxSessionKey | null): Promise<void> {
    // Runtimes that can't mount single files (OpenShell VMs) skip the context
    // file; the session then comes from NANOCLAW_MAILBOX_SESSION.
    let key = contextKey;
    if (!key) {
      const [agentGroupId, sessionId] = this.resolveSession().split('/');
      if (!agentGroupId || !sessionId) throw new MailboxRpcError('no_session', 'malformed mailbox session identity');
      key = { agentGroupId, sessionId, mailbox: null };
    }
    this.client.session = `${key.agentGroupId}/${key.sessionId}`;
    const hello = this.rpc<{ agentGroupId?: string; sessionId?: string }>('hello');
    if (hello?.agentGroupId !== key.agentGroupId || hello?.sessionId !== key.sessionId) {
      throw new Error(
        `Remote mailbox identity mismatch: host says ${hello?.agentGroupId}/${hello?.sessionId}, runner is ${key.agentGroupId}/${key.sessionId}`,
      );
    }
  }

  async run<T>(action: () => T | Promise<T>): Promise<T> {
    return action();
  }

  async stop(): Promise<void> {
    this.client.close();
  }

  getPendingMessages(limit: number, isFirstPoll: boolean): InboundMessage[] {
    // Read-only (rows stay pending until marked), so abandoning a slow call and
    // re-polling can never duplicate anything.
    const messages = this.call<InboundMessage[]>('getPendingMessages', [limit, isFirstPoll], {
      timeoutMs: this.options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
    });
    // Attachments must be on disk before the agent sees the messages naming them.
    if (messages.length > 0) syncInbox(this.rpc, this.inboxRoot);
    return messages;
  }

  markMessages(ids: string[], status: ProcessingStatus): void {
    this.rpc('markMessages', [ids, status]);
  }

  markScriptSkipped(skips: Array<{ id: string; reason: string }>): void {
    this.rpc('markScriptSkipped', [skips]);
  }

  getMessageIn(id: string): InboundMessage | undefined {
    return undef(this.rpc<InboundMessage | null>('getMessageIn', [id]));
  }

  findQuestionResponse(questionId: string): InboundMessage | undefined {
    return undef(this.rpc<InboundMessage | null>('findQuestionResponse', [questionId]));
  }

  findCliResponse(requestId: string): InboundMessage | undefined {
    return undef(this.rpc<InboundMessage | null>('findCliResponse', [requestId]));
  }

  async writeMessageOut(message: OutboundMessageDraft): Promise<number> {
    uploadOutbox(this.rpc, this.outboxRoot, message.id);
    return this.rpc<number>('writeMessageOut', [message]);
  }

  getMessageIdBySeq(sequence: number): string | null {
    return this.rpc<string | null>('getMessageIdBySeq', [sequence]);
  }

  getRoutingBySeq(sequence: number): SessionRouting | null {
    return this.rpc<SessionRouting | null>('getRoutingBySeq', [sequence]);
  }

  getLatestInboundRoute(channelType: string, platformId: string) {
    return this.rpc<{ threadId: string | null; inReplyTo: string } | null>('getLatestInboundRoute', [
      channelType,
      platformId,
    ]);
  }

  getUndeliveredMessages(): OutboundMessage[] {
    return this.rpc<OutboundMessage[]>('getUndeliveredMessages');
  }

  getDeliveryStatus(messageOutId: string) {
    return this.rpc<ReturnType<NonNullable<MailboxOperations['getDeliveryStatus']>>>('getDeliveryStatus', [
      messageOutId,
    ]);
  }

  getState(key: string): StateValue | undefined {
    return undef(this.rpc<StateValue | null>('getState', [key]));
  }

  setState(key: string, value: string): void {
    this.rpc('setState', [key, value]);
  }

  deleteState(key: string): void {
    this.rpc('deleteState', [key]);
  }

  getSessionRouting(): SessionRouting {
    return this.rpc<SessionRouting>('getSessionRouting');
  }

  getDestinations(): Destination[] {
    return this.rpc<Destination[]>('getDestinations');
  }

  findDestinationByName(name: string): Destination | undefined {
    return undef(this.rpc<Destination | null>('findDestinationByName', [name]));
  }

  findDestinationByRouting(channelType: string, platformId: string): Destination | undefined {
    return undef(this.rpc<Destination | null>('findDestinationByRouting', [channelType, platformId]));
  }

  setContainerToolInFlight(tool: string, declaredTimeoutMs: number | null): void {
    this.rpc('setContainerToolInFlight', [tool, declaredTimeoutMs]);
  }

  clearContainerToolInFlight(): void {
    this.rpc('clearContainerToolInFlight');
  }

  clearStaleProcessingAcks(): void {
    this.rpc('clearStaleProcessingAcks');
  }
}
