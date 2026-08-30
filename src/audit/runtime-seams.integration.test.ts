import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  guardEffect: 'allow' as 'allow' | 'hold' | 'deny',
  routeWriteFinished: false,
  routeWrites: 0,
  routeOrder: [] as string[],
  approvals: 0,
  handoffs: [] as Array<Record<string, unknown>>,
  taskRuns: [] as Array<Record<string, unknown>>,
  ackStatus: 'completed' as 'completed' | 'failed' | 'script-skip:error',
  taskStatus: 'pending' as 'pending' | 'completed' | 'failed',
  taskContent: 'PRIVATE TASK BODY',
  taskApplyFailure: false,
  writeFailure: false,
  pendingApproval: null as null | Record<string, unknown>,
  rejected: 0,
  sweepCallbacks: [] as Array<() => void>,
}));

const sourceSession = {
  id: 'source-session',
  agent_group_id: 'source-agent',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active' as const,
  container_status: 'stopped' as const,
  last_active: null,
  created_at: '2026-08-23T10:00:00.000Z',
};
const targetSession = { ...sourceSession, id: 'target-session', agent_group_id: 'target-agent' };

const mailbox = {
  getInboundSourceSessionId: () => null,
  getMostRecentPeerSourceSessionId: () => null,
  getTerminalProcessingAcks: () => [{
    messageId: 'task-occurrence-1', status: state.ackStatus, statusChanged: '2026-08-23T10:00:00.000Z',
  }],
  getTask: () => ({
    id: 'task-occurrence-1', seriesId: 'task-series-1', status: state.taskStatus,
    processAfter: null, recurrence: null, content: state.taskContent, timestamp: '2026-08-23T10:00:00.000Z',
    tries: 0, sequence: 2,
  }),
  applyProcessingAcks: () => {
    if (state.taskApplyFailure) throw new Error('durable task transition refused');
    state.taskStatus = state.ackStatus === 'script-skip:error' ? 'failed' : 'completed';
  },
  countDueMessages: () => 0,
  getContainerState: () => null,
  getProcessingClaims: () => [],
  countLiveTasks: () => 0,
};

vi.mock('./runtime-emitters.js', () => ({
  emitAgentHandoff: (activity: Record<string, unknown>) => {
    expect(state.routeWriteFinished).toBe(true);
    state.routeOrder.push('emit');
    state.handoffs.push(activity);
  },
  emitTaskRun: (activity: Record<string, unknown>) => {
    expect(['completed', 'failed']).toContain(state.taskStatus);
    state.taskRuns.push(activity);
  },
}));
vi.mock('../guard/index.js', () => ({
  GuardDenyError: class GuardDenyError extends Error {},
  guard: vi.fn(async () => state.guardEffect === 'hold'
    ? { effect: 'hold', approverUserId: 'approver-1' }
    : state.guardEffect === 'deny'
      ? { effect: 'deny', reason: 'destination revoked' }
      : { effect: 'allow' }),
}));
vi.mock('../db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(async (id: string) => ({ id, name: id })),
}));
vi.mock('../db/coordination.js', () => ({
  getSessionClaim: vi.fn(async () => null),
}));
vi.mock('../db/sessions.js', () => ({
  getSession: vi.fn(async (id: string) => id === targetSession.id ? targetSession : id === sourceSession.id ? sourceSession : null),
  getActiveSessions: vi.fn(async () => [sourceSession]),
  getPendingApproval: vi.fn(async () => state.pendingApproval),
  transitionPendingApprovalStatus: vi.fn(async () => true),
  deletePendingApproval: vi.fn(async () => { state.pendingApproval = null; }),
  isTaskThread: vi.fn(() => false),
  updateSession: vi.fn(),
}));
vi.mock('../session-manager.js', () => ({
  resolveSession: vi.fn(async () => ({ session: targetSession })),
  sessionDir: vi.fn(() => '/tmp/host-audit-runtime-seams'),
  withExistingMailboxSession: vi.fn(async (...args: unknown[]) => {
    const callback = args.at(-1) as (value: typeof mailbox) => unknown;
    return await callback(mailbox);
  }),
  writeSessionMessage: vi.fn(async (agentGroupId: string) => {
    if (agentGroupId === targetSession.agent_group_id) {
      if (state.writeFailure) throw new Error('durable write refused');
      state.routeWrites += 1;
      state.routeWriteFinished = true;
      state.routeOrder.push('write');
    }
  }),
  heartbeatPath: vi.fn(() => '/tmp/host-audit-no-heartbeat'),
}));
vi.mock('../container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn(() => true),
  killContainer: vi.fn(),
}));
vi.mock('../request-wake.js', () => ({
  requestWake: vi.fn(async (woken: { id: string }) => {
    if (woken.id !== targetSession.id) return;
    expect(state.handoffs).toHaveLength(1);
    state.routeOrder.push('wake');
  }),
}));
vi.mock('../modules/approvals/index.js', () => ({
  requestApproval: vi.fn(async () => { state.approvals += 1; }),
  sweepAwaitingReasonRejects: vi.fn(async () => undefined),
}));
vi.mock('../modules/permissions/db/user-roles.js', () => ({
  hasAdminPrivilege: vi.fn(async () => true),
  isGlobalAdmin: vi.fn(async () => true),
  isOwner: vi.fn(async () => true),
}));
vi.mock('../modules/approvals/finalize.js', () => ({
  finalizeReject: vi.fn(async () => { state.rejected += 1; state.pendingApproval = null; }),
}));
vi.mock('../modules/approvals/onecli-approvals.js', () => ({
  ONECLI_ACTION: 'onecli_credential',
  resolveOneCLIApproval: vi.fn(async () => false),
}));
vi.mock('../modules/approvals/reason-capture.js', () => ({ armReasonCapture: vi.fn(async () => undefined) }));
vi.mock('../modules/agent-to-agent/guard.js', () => ({
  A2A_MESSAGE_GATE_ACTION: 'a2a.send',
  a2aSend: {},
}));
vi.mock('../modules/scheduling/recurrence.js', () => ({ handleRecurrence: vi.fn(async () => undefined) }));
vi.mock('../modules/cross-session-context/index.js', () => ({ pruneEchoBacklog: vi.fn(() => 0) }));
vi.mock('../egress-lockdown.js', () => ({ ensureEgressNetwork: vi.fn() }));

import { routeAgentMessage } from '../modules/agent-to-agent/agent-route.js';
import { applyA2aMessageGate } from '../modules/agent-to-agent/message-gate.js';
import { handleApprovalsResponse } from '../modules/approvals/response-handler.js';
import { registerApprovalHandler } from '../modules/approvals/primitive.js';
import { startHostSweep, stopHostSweep } from '../host-sweep.js';

registerApprovalHandler('a2a_message_gate', applyA2aMessageGate);

const realSetTimeout = global.setTimeout;
let timeoutSpy: ReturnType<typeof vi.spyOn>;

async function runSweepTick(): Promise<void> {
  const before = state.sweepCallbacks.length;
  if (before === 0) startHostSweep();
  else state.sweepCallbacks[before - 1]();
  await vi.waitFor(() => expect(state.sweepCallbacks.length).toBe(before + 1));
}

function seedApproval(payload: Record<string, unknown>): void {
  state.pendingApproval = {
    approval_id: 'approval-1',
    session_id: sourceSession.id,
    request_id: 'approval-1',
    action: 'a2a_message_gate',
    payload: JSON.stringify(payload),
    created_at: '2026-08-23T10:00:00.000Z',
    agent_group_id: sourceSession.agent_group_id,
    channel_type: 'slack',
    platform_id: 'admin-1',
    instance: null,
    platform_message_id: null,
    expires_at: null,
    status: 'pending',
    title: 'Message approval',
    question: 'Approve?',
    options_json: '[]',
    approver_user_id: 'slack:admin-1',
  };
}

async function respond(value: string): Promise<void> {
  await handleApprovalsResponse({
    questionId: 'approval-1',
    value,
    userId: 'admin-1',
    channelType: 'slack',
    platformId: 'admin-1',
    threadId: null,
  });
}

beforeEach(() => {
  state.guardEffect = 'allow';
  state.routeWriteFinished = false;
  state.routeWrites = 0;
  state.routeOrder.splice(0);
  state.approvals = 0;
  state.handoffs.splice(0);
  state.taskRuns.splice(0);
  state.ackStatus = 'completed';
  state.taskStatus = 'pending';
  state.taskContent = 'PRIVATE TASK BODY';
  state.taskApplyFailure = false;
  state.writeFailure = false;
  state.pendingApproval = null;
  state.rejected = 0;
  state.sweepCallbacks.splice(0);
  timeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    if (ms === 60_000) {
      state.sweepCallbacks.push(fn);
      return 0 as unknown as NodeJS.Timeout;
    }
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout);
});

afterEach(async () => {
  await stopHostSweep();
  timeoutSpy.mockRestore();
});

describe('authoritative host-audit runtime seams', () => {
  it('emits one handoff only after the public route durably writes; a hold emits none', async () => {
    const msg = {
      id: 'handoff-1', platform_id: 'target-agent', content: '{"text":"PRIVATE MESSAGE"}', in_reply_to: null,
    };
    await routeAgentMessage(msg, sourceSession);
    expect(state.routeWrites).toBe(1);
    expect(state.handoffs).toEqual([{
      sourceAgentId: 'source-agent', sourceSessionId: 'source-session',
      targetAgentId: 'target-agent', activityId: 'handoff-1',
    }]);
    expect(state.routeOrder).toEqual(['write', 'emit', 'wake']);
    expect(JSON.stringify(state.handoffs)).not.toContain('PRIVATE MESSAGE');

    state.guardEffect = 'hold';
    state.routeWriteFinished = false;
    await routeAgentMessage({ ...msg, id: 'held-handoff', content: '{"text":"HELD PRIVATE MESSAGE"}' }, sourceSession);
    expect(state.routeWrites).toBe(1);
    expect(state.approvals).toBe(1);
    expect(state.handoffs).toHaveLength(1);
  });

  it('emits no task evidence when the durable terminal transition fails', async () => {
    state.taskApplyFailure = true;
    await runSweepTick();
    expect(state.taskStatus).toBe('pending');
    expect(state.taskRuns).toHaveLength(0);
  });

  it('emits once for approved replay, but never for reject, revoked access, missing target, or failed durable write', async () => {
    const payload = {
      id: 'approved-handoff', platform_id: 'target-agent', content: '{"text":"PRIVATE APPROVED MESSAGE"}',
      in_reply_to: null,
    };
    seedApproval(payload);
    await respond('approve');
    expect(state.routeWrites).toBe(1);
    expect(state.handoffs).toEqual([{
      sourceAgentId: 'source-agent', sourceSessionId: 'source-session',
      targetAgentId: 'target-agent', activityId: 'approved-handoff',
    }]);

    state.handoffs.splice(0);
    state.routeWrites = 0;
    state.routeWriteFinished = false;
    seedApproval({ ...payload, id: 'rejected-handoff' });
    await respond('reject');
    expect(state.rejected).toBe(1);
    expect(state.routeWrites).toBe(0);
    expect(state.handoffs).toHaveLength(0);

    state.guardEffect = 'deny';
    seedApproval({ ...payload, id: 'revoked-handoff' });
    await respond('approve');
    expect(state.routeWrites).toBe(0);
    expect(state.handoffs).toHaveLength(0);

    state.guardEffect = 'allow';
    seedApproval({ id: 'missing-target', content: '{"text":"PRIVATE"}', in_reply_to: null });
    await respond('approve');
    expect(state.routeWrites).toBe(0);
    expect(state.handoffs).toHaveLength(0);

    state.writeFailure = true;
    seedApproval({ ...payload, id: 'write-failed-handoff' });
    await respond('approve');
    expect(state.routeWrites).toBe(0);
    expect(state.handoffs).toHaveLength(0);
    expect(JSON.stringify(state.handoffs)).not.toContain('PRIVATE');
  });

  it.each([
    ['success with task text', 'completed', 'PRIVATE TASK BODY', 'success', 'completed'],
    ['success with empty task text', 'completed', '', 'success', 'completed'],
    ['ordinary failed turn', 'failed', 'PRIVATE FAILED BODY', 'failure', 'completed'],
    ['pre-task script failure', 'script-skip:error', 'PRIVATE SCRIPT BODY', 'failure', 'failed'],
  ] as const)('%s emits after durable terminal transition and not after restart', async (_case, ack, content, outcome, durable) => {
    state.ackStatus = ack;
    state.taskContent = content;
    await runSweepTick();
    expect(state.taskStatus).toBe(durable);
    expect(state.taskRuns).toEqual([{
      agentId: 'source-agent', sessionId: 'source-session', seriesId: 'task-series-1',
      activityId: 'task-occurrence-1', outcome,
    }]);
    expect(JSON.stringify(state.taskRuns)).not.toContain('PRIVATE TASK BODY');

    await stopHostSweep();
    state.sweepCallbacks.splice(0);
    await runSweepTick();
    expect(state.taskRuns).toHaveLength(1);
  });
});
