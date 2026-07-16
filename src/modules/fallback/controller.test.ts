import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../env.js', () => ({
  readEnvFile: () => ({}),
}));

const mockKillContainer = vi.fn();
const mockWakeContainer = vi.fn();
const mockIsContainerRunning = vi.fn();
vi.mock('../../container-runner.js', () => ({
  killContainer: (...args: unknown[]) => mockKillContainer(...args),
  wakeContainer: (...args: unknown[]) => mockWakeContainer(...args),
  isContainerRunning: (...args: unknown[]) => {
    const fn = mockIsContainerRunning as unknown as (...a: unknown[]) => boolean;
    return fn(...args);
  },
}));

const mockRestartAgentGroupContainers = vi.fn();
vi.mock('../../container-restart.js', () => ({
  restartAgentGroupContainers: (...args: unknown[]) => mockRestartAgentGroupContainers(...args),
}));

const mockGetAllAgentGroups = vi.fn(() => [] as Array<{ id: string }>);
vi.mock('../../db/agent-groups.js', () => ({
  getAllAgentGroups: () => mockGetAllAgentGroups(),
}));

const mockGetMessagingGroup = vi.fn();
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: (...args: unknown[]) => mockGetMessagingGroup(...args),
}));

const mockDeleteOrphanProcessingClaims = vi.fn((..._args: unknown[]) => 0);
const mockMarkMessageFailed = vi.fn();
vi.mock('../../db/session-db.js', () => ({
  deleteOrphanProcessingClaims: (...args: unknown[]) => mockDeleteOrphanProcessingClaims(...args),
  markMessageFailed: (...args: unknown[]) => mockMarkMessageFailed(...args),
}));

const mockGetSession = vi.fn();
vi.mock('../../db/sessions.js', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

const mockGetDeliveryAdapter = vi.fn(() => null);
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => mockGetDeliveryAdapter(),
}));

const mockOpenInboundDb = vi.fn();
const mockOpenOutboundDbRw = vi.fn();
const mockWriteOutboundDirect = vi.fn();
const mockWriteSessionMessage = vi.fn();
vi.mock('../../session-manager.js', () => ({
  openInboundDb: (...args: unknown[]) => mockOpenInboundDb(...args),
  openOutboundDbRw: (...args: unknown[]) => mockOpenOutboundDbRw(...args),
  writeOutboundDirect: (...args: unknown[]) => mockWriteOutboundDirect(...args),
  writeSessionMessage: (...args: unknown[]) => mockWriteSessionMessage(...args),
}));

const mockPickApprover = vi.fn((..._args: unknown[]) => [] as unknown[]);
const mockPickApprovalDelivery = vi.fn(async (..._args: unknown[]) => null as unknown);
vi.mock('../approvals/primitive.js', () => ({
  pickApprover: (...args: unknown[]) => mockPickApprover(...args),
  pickApprovalDelivery: (...args: unknown[]) => mockPickApprovalDelivery(...args),
}));

const mockWriteDegradationFragmentForAllGroups = vi.fn();
const mockRemoveDegradationFragmentForAllGroups = vi.fn();
vi.mock('./fragment.js', () => ({
  writeDegradationFragmentForAllGroups: () => mockWriteDegradationFragmentForAllGroups(),
  removeDegradationFragmentForAllGroups: () => mockRemoveDegradationFragmentForAllGroups(),
}));

const mockSummarizeClaudeTranscript = vi.fn((..._args: unknown[]) => null as string | null);
const mockSummarizeBackupConversation = vi.fn((..._args: unknown[]) => null as string | null);
vi.mock('./summary.js', () => ({
  summarizeClaudeTranscript: (...args: unknown[]) => mockSummarizeClaudeTranscript(...args),
  summarizeBackupConversation: (...args: unknown[]) => mockSummarizeBackupConversation(...args),
}));

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import type { Session } from '../../types.js';
import { enterFallbackState, getFallbackState, setProbe } from './db.js';
import {
  enterFallback,
  exitFallback,
  handleDoubleFaultTimeout,
  handleFallbackReport,
  handleProbeTimeout,
  handleProviderError,
  isBackupUsable,
  representMessages,
  startReturnProbe,
} from './controller.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-origin',
    agent_group_id: 'group-origin',
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: 'claude',
    status: 'active',
    container_status: 'running',
    last_active: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  vi.clearAllMocks();
  mockIsContainerRunning.mockReturnValue(true);
  mockGetAllAgentGroups.mockReturnValue([]);
  mockGetDeliveryAdapter.mockReturnValue(null);
  mockPickApprover.mockReturnValue([]);
  mockPickApprovalDelivery.mockResolvedValue(null);
  mockDeleteOrphanProcessingClaims.mockReturnValue(0);
  delete process.env.FALLBACK_PROVIDER;
  delete process.env.OPENCODE_MODEL;
});

afterEach(() => {
  closeDb();
});

describe('isBackupUsable', () => {
  it('is false when no backup provider is configured', () => {
    expect(isBackupUsable()).toBe(false);
  });

  it('is false for opencode without a model configured', () => {
    process.env.FALLBACK_PROVIDER = 'opencode';
    expect(isBackupUsable()).toBe(false);
  });

  it('is true for opencode with a model configured', () => {
    process.env.FALLBACK_PROVIDER = 'opencode';
    process.env.OPENCODE_MODEL = 'some-model';
    expect(isBackupUsable()).toBe(true);
  });

  it('is true for a non-opencode backup provider without a model', () => {
    process.env.FALLBACK_PROVIDER = 'mock';
    expect(isBackupUsable()).toBe(true);
  });
});

describe('representMessages', () => {
  it('only flips processing rows back to pending, leaving other statuses untouched', () => {
    const db = { data: new Map<string, string>() };
    const calls: Array<{ id: string; status: string }> = [];
    const fakeDb = {
      prepare: () => ({
        run: (id: string) => {
          calls.push({ id, status: 'checked' });
        },
      }),
      transaction: (fn: (ids: string[]) => void) => (ids: string[]) => fn(ids),
    } as unknown as import('better-sqlite3').Database;

    representMessages(fakeDb, ['m1', 'm2']);
    expect(calls.map((c) => c.id)).toEqual(['m1', 'm2']);
  });

  it('is a no-op for an empty message list', () => {
    let prepared = false;
    const fakeDb = {
      prepare: () => {
        prepared = true;
        return { run: vi.fn() };
      },
    } as unknown as import('better-sqlite3').Database;
    representMessages(fakeDb, []);
    expect(prepared).toBe(false);
  });
});

describe('enterFallback — no backup usable (rule 11)', () => {
  it('notifies the origin session, marks trigger messages failed, kills the container, and does not change state', async () => {
    const origin = makeSession();
    mockGetSession.mockReturnValue(origin);
    mockGetMessagingGroup.mockReturnValue({ id: 'mg-1', channel_type: 'telegram', platform_id: 'chat-1' });
    const fakeInDb = {};
    mockOpenInboundDb.mockReturnValue({ ...fakeInDb, close: vi.fn() });

    await enterFallback({
      mode: 'auto',
      classification: 'quota',
      reason: 'quota exhausted',
      resetAt: null,
      originSessionId: origin.id,
      originGroupId: origin.agent_group_id,
      messageIds: ['m1'],
    });

    expect(mockWriteOutboundDirect).toHaveBeenCalledTimes(1);
    expect(mockMarkMessageFailed).toHaveBeenCalledWith(expect.anything(), 'm1');
    expect(mockKillContainer).toHaveBeenCalledWith(origin.id, 'fallback-no-backup');
    expect(getFallbackState().active).toBe(false);
  });
});

describe('enterFallback — backup usable', () => {
  beforeEach(() => {
    process.env.FALLBACK_PROVIDER = 'mock';
  });

  it('activates fallback state, writes the fragment, notifies, and restarts the origin session', async () => {
    const origin = makeSession();
    mockGetSession.mockReturnValue(origin);
    mockGetMessagingGroup.mockReturnValue({ id: 'mg-1', channel_type: 'telegram', platform_id: 'chat-1' });
    const insertNoticeRun = vi.fn();
    mockOpenInboundDb.mockReturnValue({
      prepare: () => ({ run: insertNoticeRun }),
      transaction: (fn: (ids: string[]) => void) => (ids: string[]) => fn(ids),
      close: vi.fn(),
    });

    await enterFallback({
      mode: 'auto',
      classification: 'quota',
      reason: 'quota exhausted',
      resetAt: null,
      originSessionId: origin.id,
      originGroupId: origin.agent_group_id,
      messageIds: ['m1'],
    });

    const state = getFallbackState();
    expect(state.active).toBe(true);
    expect(state.backupProvider).toBe('mock');
    expect(mockWriteDegradationFragmentForAllGroups).toHaveBeenCalledTimes(1);
    // switch notice is deferred into fallback_pending_notices, delivered with the next chat response
    expect(insertNoticeRun).toHaveBeenCalledWith(origin.id, expect.any(String));
    expect(mockWriteOutboundDirect).not.toHaveBeenCalled();
    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(1); // origin session restart briefing
    expect(mockKillContainer).toHaveBeenCalledWith(origin.id, 'fallback-switch', expect.any(Function));
  });

  it('restarts every other agent group but skips the origin group', async () => {
    const origin = makeSession({ agent_group_id: 'group-origin' });
    mockGetSession.mockReturnValue(origin);
    mockGetMessagingGroup.mockReturnValue({ id: 'mg-1', channel_type: 'telegram', platform_id: 'chat-1' });
    mockOpenInboundDb.mockReturnValue({ close: vi.fn() });
    mockGetAllAgentGroups.mockReturnValue([{ id: 'group-origin' }, { id: 'group-other' }]);

    await enterFallback({
      mode: 'auto',
      classification: 'quota',
      reason: 'r',
      resetAt: null,
      originSessionId: origin.id,
      originGroupId: origin.agent_group_id,
      messageIds: [],
    });

    expect(mockRestartAgentGroupContainers).toHaveBeenCalledTimes(1);
    expect(mockRestartAgentGroupContainers).toHaveBeenCalledWith('group-other', 'fallback-switch', expect.any(String));
  });

  it('restarts every agent group when there is no origin session (CLI-invoked force)', async () => {
    mockGetAllAgentGroups.mockReturnValue([{ id: 'group-a' }, { id: 'group-b' }]);

    await enterFallback({
      mode: 'forced',
      classification: 'manual',
      reason: 'manual /fallback force',
      resetAt: null,
      originSessionId: null,
      originGroupId: null,
      messageIds: [],
    });

    expect(mockRestartAgentGroupContainers).toHaveBeenCalledTimes(2);
    expect(getFallbackState().active).toBe(true);
    expect(getFallbackState().mode).toBe('forced');
  });

  it('seeds a nextRetryAt for auto mode with no known resetAt, so the return-probe sweep has a due time to check against', async () => {
    mockGetAllAgentGroups.mockReturnValue([]);

    await enterFallback({
      mode: 'auto',
      classification: 'billing',
      reason: 'Credit balance is too low',
      resetAt: null,
      originSessionId: null,
      originGroupId: null,
      messageIds: [],
    });

    const state = getFallbackState();
    expect(state.nextRetryAt).not.toBeNull();
    expect(Date.parse(state.nextRetryAt!)).toBeGreaterThan(Date.now());
  });

  it('leaves nextRetryAt null for forced mode, which never auto-probes back', async () => {
    mockGetAllAgentGroups.mockReturnValue([]);

    await enterFallback({
      mode: 'forced',
      classification: 'manual',
      reason: 'manual /fallback force',
      resetAt: null,
      originSessionId: null,
      originGroupId: null,
      messageIds: [],
    });

    expect(getFallbackState().nextRetryAt).toBeNull();
  });
});

describe('exitFallback', () => {
  beforeEach(() => {
    process.env.FALLBACK_PROVIDER = 'mock';
    enterFallbackState({
      mode: 'auto',
      classification: 'quota',
      reason: 'r',
      backupModel: null,
      backupProvider: 'mock',
      resetAt: null,
      nextRetryAt: null,
      originSessionId: 'sess-origin',
      originGroupId: 'group-origin',
    });
    mockGetAllAgentGroups.mockReturnValue([{ id: 'group-origin' }, { id: 'group-other' }]);
  });

  it('via probe: clears state, removes the fragment, and skips restarting the origin group', () => {
    const origin = makeSession();
    mockGetSession.mockReturnValue(origin);
    mockGetMessagingGroup.mockReturnValue({ id: 'mg-1', channel_type: 'telegram', platform_id: 'chat-1' });

    exitFallback({ via: 'probe' });

    expect(getFallbackState().active).toBe(false);
    expect(mockRemoveDegradationFragmentForAllGroups).toHaveBeenCalledTimes(1);
    expect(mockRestartAgentGroupContainers).toHaveBeenCalledTimes(1);
    expect(mockRestartAgentGroupContainers).toHaveBeenCalledWith('group-other', 'fallback-return', expect.any(String));
  });

  it('via manual: restarts every agent group, including the origin group', () => {
    const origin = makeSession();
    mockGetSession.mockReturnValue(origin);
    mockGetMessagingGroup.mockReturnValue({ id: 'mg-1', channel_type: 'telegram', platform_id: 'chat-1' });

    exitFallback({ via: 'manual' });

    expect(mockRestartAgentGroupContainers).toHaveBeenCalledTimes(2);
    const calledGroups = mockRestartAgentGroupContainers.mock.calls.map((c) => c[0]);
    expect(calledGroups).toContain('group-origin');
    expect(calledGroups).toContain('group-other');
  });
});

describe('startReturnProbe', () => {
  it('writes a probe message on the origin session and sets probe bookkeeping', () => {
    process.env.FALLBACK_PROVIDER = 'mock';
    enterFallbackState({
      mode: 'auto',
      classification: 'quota',
      reason: 'r',
      backupModel: null,
      backupProvider: 'mock',
      resetAt: null,
      nextRetryAt: null,
      originSessionId: 'sess-origin',
      originGroupId: 'group-origin',
    });
    const origin = makeSession();
    mockGetSession.mockReturnValue(origin);

    startReturnProbe(1000);

    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(1);
    const state = getFallbackState();
    expect(state.probing).toBe(true);
    expect(state.probeSessionId).toBe(origin.id);
    expect(mockKillContainer).toHaveBeenCalledWith(origin.id, 'fallback-return-probe', expect.any(Function));
  });

  it('is a no-op when there is no recorded origin session', () => {
    startReturnProbe(1000);
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
    expect(mockKillContainer).not.toHaveBeenCalled();
  });
});

describe('handleProbeTimeout', () => {
  it('marks the probe message completed, bumps retry, and restarts the probe session', () => {
    process.env.FALLBACK_PROVIDER = 'mock';
    enterFallbackState({
      mode: 'auto',
      classification: 'quota',
      reason: 'r',
      backupModel: null,
      backupProvider: 'mock',
      resetAt: null,
      nextRetryAt: null,
      originSessionId: 'sess-origin',
      originGroupId: 'group-origin',
    });
    setProbe({
      probing: true,
      probeMessageId: 'probe-1',
      probeSessionId: 'sess-origin',
      probeStartedAt: new Date().toISOString(),
    });
    const origin = makeSession();
    mockGetSession.mockReturnValue(origin);
    const runCalls: string[] = [];
    mockOpenInboundDb.mockReturnValue({
      prepare: () => ({ run: (id: string) => runCalls.push(id) }),
      close: vi.fn(),
    });

    handleProbeTimeout();

    const state = getFallbackState();
    expect(state.probing).toBe(false);
    expect(state.retryCount).toBe(1);
    expect(mockKillContainer).toHaveBeenCalledWith(origin.id, 'fallback-probe-timeout', expect.any(Function));
  });

  it('is a no-op when not currently probing', () => {
    handleProbeTimeout();
    expect(mockKillContainer).not.toHaveBeenCalled();
  });
});

describe('handleDoubleFaultTimeout', () => {
  it('marks all given messages failed and notifies the origin conversation', () => {
    const origin = makeSession();
    mockGetMessagingGroup.mockReturnValue({ id: 'mg-1', channel_type: 'telegram', platform_id: 'chat-1' });
    const fakeInDb = {} as import('better-sqlite3').Database;

    handleDoubleFaultTimeout(origin, fakeInDb, ['m1', 'm2']);

    expect(mockMarkMessageFailed).toHaveBeenCalledTimes(2);
    expect(mockMarkMessageFailed).toHaveBeenCalledWith(fakeInDb, 'm1');
    expect(mockMarkMessageFailed).toHaveBeenCalledWith(fakeInDb, 'm2');
    expect(mockWriteOutboundDirect).toHaveBeenCalledTimes(1);
  });
});

describe('handleFallbackReport', () => {
  const fakeInDb = () =>
    ({
      prepare: () => ({ run: vi.fn() }),
      transaction: (fn: (ids: string[]) => void) => (ids: string[]) => fn(ids),
    }) as unknown as import('better-sqlite3').Database;

  it('silently re-falls-back when the return probe itself hits a limit', () => {
    process.env.FALLBACK_PROVIDER = 'mock';
    enterFallbackState({
      mode: 'auto',
      classification: 'quota',
      reason: 'r',
      backupModel: null,
      backupProvider: 'mock',
      resetAt: null,
      nextRetryAt: null,
      originSessionId: 'sess-origin',
      originGroupId: 'group-origin',
    });
    setProbe({
      probing: true,
      probeMessageId: 'probe-1',
      probeSessionId: 'sess-origin',
      probeStartedAt: new Date().toISOString(),
    });
    const session = makeSession();

    return handleFallbackReport({ classification: 'quota', messageIds: ['probe-1'] }, session, fakeInDb()).then(() => {
      const state = getFallbackState();
      expect(state.probing).toBe(false);
      expect(state.retryCount).toBe(1);
      expect(mockKillContainer).toHaveBeenCalledWith(session.id, 'fallback-reprobe-limit', expect.any(Function));
    });
  });

  it('re-presents and restarts when a report arrives while already active (not probing)', async () => {
    process.env.FALLBACK_PROVIDER = 'mock';
    enterFallbackState({
      mode: 'auto',
      classification: 'quota',
      reason: 'r',
      backupModel: null,
      backupProvider: 'mock',
      resetAt: null,
      nextRetryAt: null,
      originSessionId: 'sess-origin',
      originGroupId: 'group-origin',
    });
    const session = makeSession();

    await handleFallbackReport({ classification: 'quota', messageIds: ['m1'] }, session, fakeInDb());

    expect(mockKillContainer).toHaveBeenCalledWith(session.id, 'fallback-already-active', expect.any(Function));
  });

  it('enters fallback when inactive and a backup is usable', async () => {
    process.env.FALLBACK_PROVIDER = 'mock';
    const session = makeSession();
    mockGetSession.mockReturnValue(session);
    mockGetMessagingGroup.mockReturnValue({ id: 'mg-1', channel_type: 'telegram', platform_id: 'chat-1' });
    mockOpenInboundDb.mockReturnValue({ close: vi.fn() });

    await handleFallbackReport({ classification: 'overload', messageIds: [] }, session, fakeInDb());

    expect(getFallbackState().active).toBe(true);
    expect(getFallbackState().classification).toBe('overload');
  });
});

describe('handleProviderError', () => {
  const fakeInDb = {} as import('better-sqlite3').Database;

  it('silently re-falls-back when probing', () => {
    process.env.FALLBACK_PROVIDER = 'mock';
    enterFallbackState({
      mode: 'auto',
      classification: 'quota',
      reason: 'r',
      backupModel: null,
      backupProvider: 'mock',
      resetAt: null,
      nextRetryAt: null,
      originSessionId: 'sess-origin',
      originGroupId: 'group-origin',
    });
    setProbe({
      probing: true,
      probeMessageId: 'probe-1',
      probeSessionId: 'sess-origin',
      probeStartedAt: new Date().toISOString(),
    });
    const session = makeSession();
    const probeSession = makeSession({ id: 'sess-origin' });
    mockGetSession.mockReturnValue(probeSession);
    mockOpenInboundDb.mockReturnValue({
      prepare: vi.fn(() => ({ run: vi.fn() })),
      close: vi.fn(),
    });

    return handleProviderError({ message: 'boom' }, session, fakeInDb).then(() => {
      const state = getFallbackState();
      expect(state.probing).toBe(false);
      expect(state.retryCount).toBe(1);
      expect(mockKillContainer).toHaveBeenCalledWith(
        session.id,
        'fallback-reprobe-generic-error',
        expect.any(Function),
      );
    });
  });

  it('records the last error without restarting when already active (double fault)', async () => {
    process.env.FALLBACK_PROVIDER = 'mock';
    enterFallbackState({
      mode: 'auto',
      classification: 'quota',
      reason: 'r',
      backupModel: null,
      backupProvider: 'mock',
      resetAt: null,
      nextRetryAt: null,
      originSessionId: 'sess-origin',
      originGroupId: 'group-origin',
    });
    const session = makeSession();

    await handleProviderError({ message: 'backup down too' }, session, fakeInDb);

    expect(getFallbackState().lastError).toBe('backup down too');
    expect(mockKillContainer).not.toHaveBeenCalled();
  });

  it('is a no-op (besides logging) when native provider is running and fallback is inactive', async () => {
    const session = makeSession();
    await handleProviderError({ message: 'native hiccup' }, session, fakeInDb);
    expect(getFallbackState().lastError).toBeNull();
    expect(mockKillContainer).not.toHaveBeenCalled();
  });
});
