/**
 * Code-boundary approval — the host half of D17's detached boundary confirm,
 * in onecli-approvals' blocking shape (pending map + pending_approvals row +
 * ask_question card + expiry timer + restart sweep). The difference is where
 * the decision LANDS: OneCLI resolves an in-memory Promise held by an open
 * HTTP callback; here the waiter is a hook subprocess inside the container
 * polling a decision FILE, so resolution writes that file and the map holds
 * only the expiry timer.
 *
 * Transport is a request/decision file pair under the session dir (the
 * container's /workspace) — deliberately NOT the mailbox DBs: the two-DB
 * surface is the incoming-mailbox workstream's message transport, and a
 * boundary confirm is a blocking decision with one writer per side (request:
 * hook; decision: host), which the pair preserves. The two halves live in
 * different dirs because "one writer per side" must be enforced, not stated:
 * requests ride the RW `<sessDir>/code-boundary`, decisions land in
 * `<sessDir>/code-boundary-decisions`, which the spawn nested-RO-mounts so
 * the agent cannot mint its own allow (E-t7 review; the mount is
 * code-mode/permissions.ts boundaryDecisionMounts, the container half's
 * trust check is code-runner/boundary.ts decisionsDirTrusted). The hook
 * deletes the request it wrote once decided; it CANNOT delete decisions, so
 * the age sweep below owns those.
 *
 * Discovery is a small poll over running sessions' dirs — v0 by design; the
 * container-runner already tracks sessions, and a dir scan every few seconds
 * against a 10-minute decision window costs nothing perceptible.
 */
import fs from 'fs';
import path from 'path';

import { pickApprovalDelivery, pickApprover } from './primitive.js';
import { BOUNDARY_DECISIONS_SUBDIR } from '../../code-mode/permissions.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  createPendingApproval,
  deletePendingApproval,
  getPendingApprovalsByAction,
  getRunningSessions,
  updatePendingApprovalStatus,
} from '../../db/sessions.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { sessionDir } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';

export const CODE_BOUNDARY_ACTION = 'code_boundary';

/** The request half's home inside a session dir — mirrors code-runner/boundary.ts
 *  BOUNDARY_DIR. The decision half lives in BOUNDARY_DECISIONS_SUBDIR (the RO
 *  mount, code-mode/permissions.ts). */
export const BOUNDARY_SUBDIR = 'code-boundary';

/**
 * Files older than this are swept from both halves' dirs on scan. Well past
 * every rung of the deny ladder (host expiry 590s, hook poll ceiling 600s,
 * settings kill 660s): by then a decision has been read or its reader is
 * dead, and a request still sitting there belongs to a hook the CLI killed.
 * The hour is pure margin — the sweep is hygiene, not semantics.
 */
export const BOUNDARY_FILE_MAX_AGE_MS = 3_600_000;

/**
 * Deny at 590s so the hook (whose own poll ceiling is 600s, settings kill
 * 660s) reads an EXPLICIT deny rather than manufacturing one — every rung of
 * the ladder under the next.
 */
export const HOST_EXPIRY_MS = 590_000;

const SCAN_INTERVAL_MS = 5_000;

type ExpiryReason = 'no response' | 'host restarted';

interface PendingState {
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingState>();
/** Request files already routed (or refused) this process — the scan is a poll, not a queue. */
const routed = new Set<string>();
let scanTimer: NodeJS.Timeout | null = null;
let adapterRef: ChannelDeliveryAdapter | null = null;

function shortApprovalId(): string {
  // Same 10-byte shape as onecli-approvals and for the same reason: the id
  // rides a Telegram callback_data field with a hard 64-byte limit.
  return `cb-${Math.random().toString(36).slice(2, 10)}`;
}

export function startCodeBoundaryWatcher(deliveryAdapter: ChannelDeliveryAdapter): void {
  if (scanTimer) return;
  adapterRef = deliveryAdapter;
  sweepStaleBoundaryApprovals().catch((err) => log.error('Code-boundary sweep failed', { err }));
  scanTimer = setInterval(() => {
    scanCodeBoundaryRequests().catch((err) => log.error('Code-boundary scan failed', { err }));
  }, SCAN_INTERVAL_MS);
}

export function stopCodeBoundaryWatcher(): void {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  for (const state of pending.values()) clearTimeout(state.timer);
  pending.clear();
  routed.clear();
  adapterRef = null;
}

/** One scan pass, exported so tests drive it without timers. */
export async function scanCodeBoundaryRequests(): Promise<void> {
  if (!adapterRef) return;
  for (const session of await getRunningSessions()) {
    const sessDir = sessionDir(session.agent_group_id, session.id);
    const dir = path.join(sessDir, BOUNDARY_SUBDIR);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.request.json'));
    } catch {
      files = []; // no request dir — not a code-mode session, or nothing asked yet
    }
    for (const file of files) {
      const requestFile = path.join(dir, file);
      if (routed.has(requestFile)) continue;
      routed.add(requestFile);
      await routeRequest(session, requestFile).catch((err) => {
        log.error('Code-boundary request not routed', { requestFile, err });
      });
    }
    // Hygiene: decisions outlive their readers (the hook cannot delete from
    // the RO mount) and a killed hook orphans its request. Routing above ran
    // first, so anything this old already got its explicit deny.
    sweepAgedBoundaryFiles(dir, Date.now());
    sweepAgedBoundaryFiles(path.join(sessDir, BOUNDARY_DECISIONS_SUBDIR), Date.now());
  }
}

/** Remove pair files older than BOUNDARY_FILE_MAX_AGE_MS. Exported for tests. */
export function sweepAgedBoundaryFiles(dir: string, nowMs: number): void {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.request.json') || f.endsWith('.decision.json'));
  } catch {
    return;
  }
  for (const file of files) {
    const full = path.join(dir, file);
    try {
      if (nowMs - fs.statSync(full).mtimeMs > BOUNDARY_FILE_MAX_AGE_MS) {
        fs.rmSync(full, { force: true });
        routed.delete(full);
      }
    } catch {
      // Raced away by the hook's own cleanup — already gone is the goal state.
    }
  }
}

interface BoundaryRequestFile {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  reason: string;
  at: string;
}

/** The exact charset of ids the hook mints — anything else fails closed. */
const REQUEST_ID_RE = /^[0-9a-f-]{1,64}$/i;

function writeDecision(decisionFile: string, decision: 'allow' | 'deny', reason: string): void {
  // The decisions dir is host-prepared at spawn (boundaryDecisionMounts), but
  // a session spawned before the mount landed still deserves its explicit deny.
  fs.mkdirSync(path.dirname(decisionFile), { recursive: true });
  // tmp+rename: the hook polls this path and must never parse a torn file.
  const tmp = `${decisionFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ decision, reason }));
  fs.renameSync(tmp, decisionFile);
}

async function routeRequest(session: Session, requestFile: string): Promise<void> {
  if (!adapterRef) return;
  const decisionsDir = path.join(sessionDir(session.agent_group_id, session.id), BOUNDARY_DECISIONS_SUBDIR);
  const decisionFileFor = (id: string) => path.join(decisionsDir, `${id}.decision.json`);
  // A refused request never resolves, so the file's own deletion falls to the
  // host (the hook only clears requests it saw decided). Best-effort — a file
  // that will not die still cannot re-route (`routed`) and ages into the sweep.
  const refuseRequestFile = () => {
    try {
      fs.rmSync(requestFile, { force: true });
    } catch (err) {
      log.warn('Refused code-boundary request not removed', { requestFile, err });
    }
  };

  // Refuse anything not exactly request-shaped by DENYING it — a malformed
  // request has a hook blocked behind it, and silence would make that hook
  // wait out its full TTL for a decision that can never come. An unreadable
  // BODY still gets its deny: the hook mints the filename from the same id it
  // puts in the body (boundary.ts requestPath), so the basename — under the
  // same charset check as any other id — is enough to address the decision.
  let request: BoundaryRequestFile;
  try {
    request = JSON.parse(fs.readFileSync(requestFile, 'utf8')) as BoundaryRequestFile;
  } catch (error) {
    log.warn('Code-boundary request unreadable — denying by its filename id', {
      requestFile,
      error: String(error),
    });
    const nameId = path.basename(requestFile).replace(/\.request\.json$/, '');
    if (REQUEST_ID_RE.test(nameId)) {
      writeDecision(decisionFileFor(nameId), 'deny', 'unreadable request (refused, fails closed)');
    }
    refuseRequestFile();
    return;
  }
  if (typeof request.id !== 'string' || !REQUEST_ID_RE.test(request.id)) {
    log.warn('Code-boundary request id fails the charset — refused', { requestFile });
    refuseRequestFile();
    return; // an id we cannot trust is an id we must not build a path from
  }
  const requestAtMs = Date.parse(request.at ?? '');
  const decisionFile = decisionFileFor(request.id);
  if (!Number.isFinite(requestAtMs)) {
    writeDecision(decisionFile, 'deny', 'malformed request timestamp (refused, fails closed)');
    refuseRequestFile();
    return;
  }

  const expiresAtMs = requestAtMs + HOST_EXPIRY_MS;
  if (expiresAtMs <= Date.now()) {
    // Found too late (host was down): the hook has already denied itself or
    // is about to — say so explicitly rather than raising an unanswerable card.
    writeDecision(decisionFile, 'deny', 'approval window already over when the host saw the request');
    refuseRequestFile();
    return;
  }

  const group = await getAgentGroup(session.agent_group_id);
  const approvers = await pickApprover(session.agent_group_id);
  if (approvers.length === 0) {
    writeDecision(decisionFile, 'deny', 'no eligible approver configured');
    return;
  }
  const target = await pickApprovalDelivery(approvers, '');
  if (!target) {
    writeDecision(decisionFile, 'deny', 'no DM channel for any approver');
    return;
  }

  const approvalId = shortApprovalId();
  const title = 'Sandbox Boundary';
  const question = buildQuestion(group?.name ?? session.agent_group_id, request);
  const options = [
    { label: 'Allow', selectedLabel: '✅ Allowed', value: 'approve', style: 'primary' as const },
    { label: 'Deny', selectedLabel: '❌ Denied', value: 'deny', style: 'danger' as const },
  ];

  let platformMessageId: string | undefined;
  try {
    platformMessageId = await adapterRef.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({ type: 'ask_question', questionId: approvalId, title, question, options }),
    );
  } catch (err) {
    log.error('Code-boundary card not delivered — denying', { approvalId, requestFile, err });
    writeDecision(decisionFile, 'deny', 'approval card could not be delivered');
    return;
  }

  await createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    request_id: request.id,
    action: CODE_BOUNDARY_ACTION,
    payload: JSON.stringify({
      requestId: request.id,
      decisionFile,
      requestFile,
      toolName: request.toolName,
      reason: request.reason,
      approver: target.userId,
    }),
    created_at: new Date().toISOString(),
    agent_group_id: session.agent_group_id,
    channel_type: target.messagingGroup.channel_type,
    platform_id: target.messagingGroup.platform_id,
    platform_message_id: platformMessageId ?? null,
    expires_at: new Date(expiresAtMs).toISOString(),
    status: 'pending',
    title,
    question,
    options_json: JSON.stringify(options),
  });

  const timer = setTimeout(
    () => {
      if (!pending.delete(approvalId)) return;
      try {
        writeDecision(decisionFile, 'deny', 'no approval before the window closed (D17: timeout is deny)');
      } catch (err) {
        log.error('Code-boundary expiry could not write the deny decision', { approvalId, decisionFile, err });
      }
      expireApproval(approvalId, 'no response').catch((err) =>
        log.error('Failed to mark code-boundary approval expired', { approvalId, err }),
      );
    },
    Math.max(1000, expiresAtMs - Date.now()),
  );
  pending.set(approvalId, { timer });
  log.info('Code-boundary approval requested', { approvalId, requestFile, approver: target.userId });
}

/** Called from the approvals response handler when a card button is clicked. */
export async function resolveCodeBoundaryApproval(approvalId: string, selectedOption: string): Promise<boolean> {
  const state = pending.get(approvalId);
  if (!state) return false;
  pending.delete(approvalId);
  clearTimeout(state.timer);

  const row = (await getPendingApprovalsByAction(CODE_BOUNDARY_ACTION)).find((r) => r.approval_id === approvalId);
  const decision = selectedOption === 'approve' ? 'allow' : 'deny';
  if (row) {
    try {
      const payload = JSON.parse(row.payload) as { decisionFile?: string };
      if (payload.decisionFile) {
        writeDecision(payload.decisionFile, decision, `${decision} by approver`);
      }
    } catch (err) {
      log.error('Code-boundary decision file not written', { approvalId, err });
    }
  }
  await updatePendingApprovalStatus(approvalId, decision === 'allow' ? 'approved' : 'rejected');
  await deletePendingApproval(approvalId);
  log.info('Code-boundary approval resolved', { approvalId, decision });
  return true;
}

async function expireApproval(approvalId: string, reason: ExpiryReason): Promise<void> {
  const row = (await getPendingApprovalsByAction(CODE_BOUNDARY_ACTION)).find((r) => r.approval_id === approvalId);
  if (!row) return;
  await updatePendingApprovalStatus(approvalId, 'expired');
  await editCardExpired(row, reason);
  await deletePendingApproval(approvalId);
  log.info('Code-boundary approval expired', { approvalId, reason });
}

async function editCardExpired(row: PendingApproval, reason: ExpiryReason): Promise<void> {
  if (!adapterRef || !row.platform_message_id || !row.channel_type || !row.platform_id) return;
  const resolution =
    reason === 'no response'
      ? '⏱️ Timed out — denied (D17: no approval is a deny)'
      : '⏱️ Timed out — host restarted before resolution (denied)';
  try {
    await adapterRef.deliver(
      row.channel_type,
      row.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        operation: 'edit',
        messageId: row.platform_message_id,
        text: [row.title, row.question, resolution].filter(Boolean).join('\n\n'),
        terminalCard: { title: row.title, question: row.question, resolution },
      }),
    );
  } catch (err) {
    log.warn('Failed to edit expired code-boundary card', { approvalId: row.approval_id, err });
  }
}

/** Orphans from a previous process: the click can never land — deny and say so. */
async function sweepStaleBoundaryApprovals(): Promise<void> {
  const rows = await getPendingApprovalsByAction(CODE_BOUNDARY_ACTION);
  if (rows.length === 0) return;
  log.info('Sweeping stale code-boundary approvals from previous process', { count: rows.length });
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as { decisionFile?: string };
      // Best-effort: the session (and its dir) may be gone; the hook that
      // was waiting has long since denied itself at its own ceiling.
      if (payload.decisionFile && fs.existsSync(path.dirname(payload.decisionFile))) {
        writeDecision(payload.decisionFile, 'deny', 'host restarted before resolution');
      }
    } catch (err) {
      log.warn('Stale code-boundary row without a usable decision path', { approvalId: row.approval_id, err });
    }
    await editCardExpired(row, 'host restarted');
    await deletePendingApproval(row.approval_id);
  }
}

function buildQuestion(agentName: string, request: BoundaryRequestFile): string {
  const lines = [`*Agent:* ${agentName}`, `*Boundary:* ${request.reason}`];
  const command = request.toolInput?.command;
  const filePath = request.toolInput?.file_path;
  if (typeof command === 'string' && command) lines.push('```', command.slice(0, 900), '```');
  else if (typeof filePath === 'string' && filePath) lines.push(`*${request.toolName}:* ${filePath.slice(0, 900)}`);
  else lines.push(`*Tool:* ${request.toolName}`);
  return lines.join('\n');
}
