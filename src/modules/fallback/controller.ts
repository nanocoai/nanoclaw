/**
 * Host fallback orchestration — the only place that actually switches the
 * install to/from the backup provider, notifies the owner, and restarts
 * containers. `override.ts` decides which provider is *effective* given
 * state; this file is what *changes* that state.
 */
import type Database from 'better-sqlite3';
import { killContainer, wakeContainer } from '../../container-runner.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { deleteOrphanProcessingClaims, markMessageFailed } from '../../db/session-db.js';
import { getSession } from '../../db/sessions.js';
import { deliverSessionMessages, getDeliveryAdapter } from '../../delivery.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { openInboundDb, openOutboundDbRw, writeOutboundDirect, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import {
  bumpRetry,
  clearFallbackState,
  enterFallbackState,
  getFallbackState,
  setLastError,
  setProbe,
  type FallbackClassification,
  type FallbackMode,
} from './db.js';
import { nextRetryAt } from './decide.js';
import { removeDegradationFragmentForAllGroups, writeDegradationFragmentForAllGroups } from './fragment.js';
import {
  doubleFaultNotice,
  forwardBriefing,
  noBackupNotice,
  returnBriefing,
  returnNotice,
  shortReturnBriefing,
  shortSwitchBriefing,
  switchAutoNotice,
  switchForcedNotice,
} from './notices.js';
import { summarizeBackupConversation, summarizeClaudeTranscript } from './summary.js';

const envConfig = readEnvFile(['FALLBACK_PROVIDER', 'OPENCODE_MODEL', 'OLLAMA_MODEL']);

function fallbackProviderEnv(): string {
  return process.env.FALLBACK_PROVIDER || envConfig.FALLBACK_PROVIDER || '';
}

function opencodeModelEnv(): string {
  return process.env.OPENCODE_MODEL || envConfig.OPENCODE_MODEL || '';
}

function ollamaModelEnv(): string {
  return process.env.OLLAMA_MODEL || envConfig.OLLAMA_MODEL || '';
}

/**
 * Runtime check (spec rule 11): a backup provider must be configured and, if
 * it's `opencode`, a model must be set too. The OneCLI secret itself can't be
 * verified host-side — a missing/invalid credential surfaces later as an
 * auth failure at runtime, which is the "double fault" case handled by
 * `handleProviderError`, not this check.
 */
export function isBackupUsable(): boolean {
  const provider = fallbackProviderEnv();
  if (!provider) return false;
  if (provider === 'opencode' && !opencodeModelEnv()) return false;
  return true;
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function nextRetryIso(retryCount: number): string {
  return new Date(nextRetryAt(retryCount, Date.now())).toISOString();
}

function markMessageCompleted(inDb: Database.Database, messageId: string): void {
  inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ?").run(messageId);
}

/** UPDATE → pending, without touching `tries` — these messages weren't the provider's fault. */
export function representMessages(inDb: Database.Database, messageIds: string[]): void {
  if (messageIds.length === 0) return;
  const stmt = inDb.prepare("UPDATE messages_in SET status = 'pending' WHERE id = ? AND status = 'processing'");
  const tx = inDb.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(id);
  });
  tx(messageIds);
}

async function notifyApprover(session: Session, text: string): Promise<void> {
  try {
    const approvers = pickApprover(session.agent_group_id);
    const originChannelType = session.messaging_group_id
      ? (getMessagingGroup(session.messaging_group_id)?.channel_type ?? '')
      : '';
    const target = await pickApprovalDelivery(approvers, originChannelType);
    if (!target) {
      log.warn('Fallback notice: no reachable approver DM', { sessionId: session.id });
      return;
    }
    const adapter = getDeliveryAdapter();
    if (adapter) {
      await adapter.deliver(
        target.messagingGroup.channel_type,
        target.messagingGroup.platform_id,
        null,
        'chat',
        JSON.stringify({ text }),
      );
    }
  } catch (err) {
    log.warn('Failed to deliver fallback notice to approver', { sessionId: session.id, err });
  }
}

/** Writes straight into the origin conversation's outbound.db; falls back to an approver DM if that's not possible. */
async function notifyConversationOrOwner(session: Session, text: string): Promise<void> {
  try {
    const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
    if (!mg) throw new Error('origin session has no messaging group');
    writeOutboundDirect(session.agent_group_id, session.id, {
      id: generateId('fallback-notice'),
      kind: 'chat',
      platformId: mg.platform_id,
      channelType: mg.channel_type,
      threadId: session.thread_id,
      content: JSON.stringify({ text }),
    });
  } catch (err) {
    log.warn('Falling back to approver DM for fallback notice', { sessionId: session.id, err });
    await notifyApprover(session, text);
    return;
  }
  // Push immediately instead of waiting on a poll — this notice is
  // host-composed and doesn't need the container, but the 1s "active"
  // delivery poll only covers sessions whose container is currently
  // running/idle. If it isn't, only the 60s sweep poll would eventually
  // pick this up, turning an instant notice into a up-to-a-minute wait.
  try {
    await deliverSessionMessages(session);
  } catch (err) {
    log.warn('Failed to push immediate delivery for fallback notice', { sessionId: session.id, err });
  }
}

function restartOriginSession(session: Session, briefing: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: generateId('fallback-switch'),
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text: briefing, sender: 'system', senderId: 'system' }),
    onWake: 1,
  });

  killContainer(session.id, 'fallback-switch', () => {
    try {
      const outDb = openOutboundDbRw(session.agent_group_id, session.id);
      try {
        const cleared = deleteOrphanProcessingClaims(outDb);
        if (cleared > 0)
          log.info('Cleared orphan processing claims after fallback switch', { sessionId: session.id, cleared });
      } finally {
        outDb.close();
      }
    } catch (err) {
      log.warn('Failed to clear orphan processing claims after fallback switch', { sessionId: session.id, err });
    }
    const s = getSession(session.id);
    if (s) wakeContainer(s);
  });
}

/** Restarts a session's container and waits for it to fully exit before waking a fresh one. */
function killAndWake(session: Session, reason: string): void {
  killContainer(session.id, reason, () => {
    const s = getSession(session.id);
    if (s) wakeContainer(s);
  });
}

export interface EnterFallbackOpts {
  mode: FallbackMode;
  classification: FallbackClassification;
  reason: string;
  resetAt: string | null;
  originSessionId: string | null;
  originGroupId: string | null;
  /** Trigger messages left `processing` by the caller, to be re-presented on the backup provider. */
  messageIds?: string[];
}

/**
 * Switches the install to the backup provider (spec's central transition).
 * No-ops into rule 11 (immediate failure notice, no state change) if no
 * backup is usable.
 */
export async function enterFallback(opts: EnterFallbackOpts): Promise<void> {
  const originSession = opts.originSessionId ? getSession(opts.originSessionId) : undefined;
  const messageIds = opts.messageIds ?? [];

  if (!isBackupUsable()) {
    log.warn('Fallback triggered but no backup provider is configured (rule 11)', {
      classification: opts.classification,
      reason: opts.reason,
      originSessionId: opts.originSessionId,
    });
    if (originSession) {
      await notifyConversationOrOwner(originSession, noBackupNotice(opts.classification, opts.resetAt));
      if (messageIds.length > 0) {
        const inDb = openInboundDb(originSession.agent_group_id, originSession.id);
        try {
          for (const id of messageIds) markMessageFailed(inDb, id);
        } finally {
          inDb.close();
        }
      }
      killContainer(originSession.id, 'fallback-no-backup');
    }
    return;
  }

  const backupProvider = fallbackProviderEnv();
  const model =
    backupProvider === 'opencode' ? opencodeModelEnv() : backupProvider === 'ollama' ? ollamaModelEnv() : null;
  // Forced fallback never auto-probes back (spec rule 13, decide.ts) so it
  // has no retry schedule. Auto fallback needs one seeded immediately —
  // otherwise decideFallbackSweep's dueAt is NaN forever and the install
  // never attempts a return-to-native probe on its own.
  const initialNextRetry = opts.mode === 'forced' ? null : (opts.resetAt ?? nextRetryIso(0));

  enterFallbackState({
    mode: opts.mode,
    classification: opts.classification,
    reason: opts.reason,
    backupProvider,
    backupModel: model,
    resetAt: opts.resetAt,
    nextRetryAt: initialNextRetry,
    originSessionId: opts.originSessionId,
    originGroupId: opts.originGroupId,
  });

  if (originSession && messageIds.length > 0) {
    const inDb = openInboundDb(originSession.agent_group_id, originSession.id);
    try {
      representMessages(inDb, messageIds);
    } finally {
      inDb.close();
    }
  }

  try {
    writeDegradationFragmentForAllGroups();
  } catch (err) {
    log.warn('Failed to write fallback degradation fragment', { err });
  }

  const notice =
    opts.mode === 'forced'
      ? switchForcedNotice(backupProvider, model)
      : switchAutoNotice(opts.classification, backupProvider, opts.resetAt, model);
  if (originSession) {
    try {
      const inDb = openInboundDb(originSession.agent_group_id, originSession.id);
      inDb.prepare('CREATE TABLE IF NOT EXISTS fallback_pending_notices (session_id TEXT, notice_text TEXT)').run();
      inDb
        .prepare('INSERT OR REPLACE INTO fallback_pending_notices (session_id, notice_text) VALUES (?, ?)')
        .run(originSession.id, notice);
      inDb.close();
      log.info('Deferred fallback notice — will be delivered with next chat response', { sessionId: originSession.id });
    } catch (err) {
      log.warn('Failed to store deferred fallback notice, falling back to immediate delivery', {
        sessionId: originSession.id,
        err,
      });
      await notifyConversationOrOwner(originSession, notice);
    }
  }

  let forwardSummary: string | null = null;
  if (originSession) {
    try {
      forwardSummary = summarizeClaudeTranscript(originSession.agent_group_id, originSession.id);
    } catch (err) {
      log.warn('Failed to build forward context summary', { err });
    }
  }
  const briefing = forwardBriefing(forwardSummary, backupProvider, model);

  if (originSession) {
    restartOriginSession(originSession, briefing);
  }
  for (const group of getAllAgentGroups()) {
    if (originSession && group.id === originSession.agent_group_id) continue;
    try {
      restartAgentGroupContainers(group.id, 'fallback-switch', shortSwitchBriefing(backupProvider, model));
    } catch (err) {
      log.warn('Failed to restart agent group for fallback switch', { groupId: group.id, err });
    }
  }

  log.warn('Entered fallback', {
    mode: opts.mode,
    classification: opts.classification,
    resetAt: opts.resetAt,
    originSessionId: opts.originSessionId,
    originGroupId: opts.originGroupId,
    backupProvider,
  });
}

/**
 * Returns the install to the native provider. `via: 'probe'` is called only
 * after a successful automatic return probe (the origin session is already
 * running native — it isn't restarted); `via: 'manual'` is the unconditional
 * `/fallback return` command path (the origin group's containers are still
 * on the backup and must be restarted like any other group).
 */
export function exitFallback(opts: { via: 'probe' | 'manual' }): void {
  const state = getFallbackState();
  const originSession = state.originSessionId ? getSession(state.originSessionId) : undefined;
  const originGroupId = originSession?.agent_group_id ?? state.originGroupId ?? null;

  clearFallbackState();

  try {
    removeDegradationFragmentForAllGroups();
  } catch (err) {
    log.warn('Failed to remove fallback degradation fragment', { err });
  }

  if (originSession) {
    void notifyConversationOrOwner(originSession, returnNotice());
  }

  for (const group of getAllAgentGroups()) {
    if (opts.via === 'probe' && originGroupId && group.id === originGroupId) continue;
    try {
      restartAgentGroupContainers(group.id, 'fallback-return', shortReturnBriefing());
    } catch (err) {
      log.warn('Failed to restart agent group after fallback return', { groupId: group.id, err });
    }
  }

  log.warn('Exited fallback', {
    via: opts.via,
    previousClassification: state.classification,
    retryCount: state.retryCount,
  });
}

/** Starts an automatic return-to-native probe: the origin session is restarted on native Claude for one turn. */
export function startReturnProbe(now: number): void {
  const state = getFallbackState();
  if (!state.originSessionId) {
    log.warn('Cannot start return probe: no origin session recorded');
    return;
  }
  const session = getSession(state.originSessionId);
  if (!session) {
    log.warn('Cannot start return probe: origin session no longer exists', { sessionId: state.originSessionId });
    return;
  }

  let returnSummary: string | null = null;
  try {
    returnSummary = summarizeBackupConversation(session.agent_group_id, state.enteredAt);
  } catch (err) {
    log.warn('Failed to build return-probe context summary', { err });
  }

  const probeMessageId = generateId('fallback-probe');
  writeSessionMessage(session.agent_group_id, session.id, {
    id: probeMessageId,
    kind: 'chat',
    timestamp: new Date(now).toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text: returnBriefing(returnSummary), sender: 'system', senderId: 'system' }),
    onWake: 1,
  });

  setProbe({
    probing: true,
    probeMessageId,
    probeSessionId: session.id,
    probeStartedAt: new Date(now).toISOString(),
  });

  killAndWake(session, 'fallback-return-probe');
  log.info('Started fallback return probe', { sessionId: session.id, probeMessageId });
}

/** Probe never completed within its window — back off and stay on the backup. Silent (spec: no chat notice). */
export function handleProbeTimeout(): void {
  const state = getFallbackState();
  if (!state.probing || !state.probeSessionId) return;
  const session = getSession(state.probeSessionId);
  log.warn('Return probe timed out — reverting to backup', { sessionId: state.probeSessionId });

  if (session && state.probeMessageId) {
    const inDb = openInboundDb(session.agent_group_id, session.id);
    try {
      markMessageCompleted(inDb, state.probeMessageId);
    } finally {
      inDb.close();
    }
  }

  bumpRetry(nextRetryIso(state.retryCount));

  if (session) {
    killAndWake(session, 'fallback-probe-timeout');
  }
}

/** The backup provider itself breached the response guarantee — no third fallback to switch to, so just fail and notify (no retry loop). */
export function handleDoubleFaultTimeout(session: Session, inDb: Database.Database, messageIds: string[]): void {
  log.warn('Backup provider also breached the response guarantee (double fault)', {
    sessionId: session.id,
    messageIds,
  });
  for (const id of messageIds) markMessageFailed(inDb, id);
  void notifyConversationOrOwner(session, doubleFaultNotice());
}

/**
 * Delivery-action handler for `fallback_report` — the container reporting a
 * hit limit. See fallback-report.ts (container side) for the payload shape.
 */
export async function handleFallbackReport(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const classification = content.classification as FallbackClassification;
  const resetAt = typeof content.resetAt === 'number' ? new Date(content.resetAt).toISOString() : null;
  const message = typeof content.message === 'string' ? content.message : '';
  const messageIds = Array.isArray(content.messageIds) ? (content.messageIds as string[]) : [];
  const state = getFallbackState();

  if (state.probing) {
    // Rule 10: the return probe itself hit a limit again — silent re-fallback.
    // The probe message is marked completed (never re-presented to the
    // backup) so the return briefing never ends up in front of it.
    log.warn('Return probe hit a limit — silent re-fallback', { sessionId: session.id, classification });
    const rest = messageIds.filter((id) => id !== state.probeMessageId);
    if (state.probeMessageId && messageIds.includes(state.probeMessageId)) {
      markMessageCompleted(inDb, state.probeMessageId);
    }
    if (rest.length > 0) representMessages(inDb, rest);
    bumpRetry(nextRetryIso(state.retryCount));
    killAndWake(session, 'fallback-reprobe-limit');
    return;
  }

  if (state.active) {
    // Duplicate report while already in fallback — just re-present and restart.
    log.info('Fallback report while already active — re-presenting', { sessionId: session.id, classification });
    representMessages(inDb, messageIds);
    killAndWake(session, 'fallback-already-active');
    return;
  }

  await enterFallback({
    mode: 'auto',
    classification,
    reason: message || classification,
    resetAt,
    originSessionId: session.id,
    originGroupId: session.agent_group_id,
    messageIds,
  });
}

/**
 * Delivery-action handler for `provider_error` — a generic (non-limit)
 * provider error. The container already surfaced a single user-facing
 * message for this, so this handler only updates state/bookkeeping.
 */
export async function handleProviderError(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const message = typeof content.message === 'string' ? content.message : '';
  const state = getFallbackState();

  if (state.probing) {
    log.warn('Return probe failed with a generic error — silent re-fallback', { sessionId: session.id, message });
    bumpRetry(nextRetryIso(state.retryCount));
    killAndWake(session, 'fallback-reprobe-generic-error');
    return;
  }

  if (state.active) {
    setLastError(message);
    log.warn('Provider error while fallback active (double fault) — already surfaced to chat by the container', {
      sessionId: session.id,
      message,
    });
    return;
  }

  log.info('Provider error reported (native provider, no fallback active)', { sessionId: session.id, message });
}
