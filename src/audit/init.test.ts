import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: { shutdown: null as null | (() => Promise<void>) },
  initializeAuditStore: vi.fn(async () => ({})),
  pruneAuditLogIfDue: vi.fn(async () => 0),
  initAuditHooks: vi.fn(),
  shutdownAuditHooks: vi.fn(async () => undefined),
  closeAuditWriteAdmissionAndWait: vi.fn(async () => undefined),
  shutdownAuditStdout: vi.fn(),
  initializeAuditPseudonymizer: vi.fn(),
}));

vi.mock('./config.js', () => ({
  AUDIT_ENABLED: true,
  AUDIT_RETENTION_HOURS: 12,
  HOST_AUDIT_PSEUDONYM_KEY_FILE: '/private/test-key',
}));
vi.mock('./store.js', () => ({
  initializeAuditStore: mocks.initializeAuditStore,
  pruneAuditLogIfDue: mocks.pruneAuditLogIfDue,
  markPrunedThisHour: vi.fn(),
}));
vi.mock('./hooks.js', () => ({
  initAuditHooks: mocks.initAuditHooks,
  maintainAuditHooks: vi.fn(),
  shutdownAuditHooks: mocks.shutdownAuditHooks,
}));
vi.mock('./emit.js', () => ({
  openAuditWriteAdmission: vi.fn(),
  closeAuditWriteAdmissionAndWait: mocks.closeAuditWriteAdmissionAndWait,
}));
vi.mock('./stdout.js', () => ({ shutdownAuditStdout: mocks.shutdownAuditStdout }));
vi.mock('./pseudonym.js', () => ({ initializeAuditPseudonymizer: mocks.initializeAuditPseudonymizer }));
vi.mock('../host-lifecycle.js', () => ({
  onHostStart: vi.fn(),
  onHostShutdown: (callback: () => Promise<void>) => {
    mocks.state.shutdown = callback;
  },
}));
vi.mock('../log.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));

import { initAuditLog } from './init.js';

beforeEach(() => {
  mocks.state.shutdown = null;
  vi.clearAllMocks();
});

describe('PostgreSQL Host audit lifecycle', () => {
  it('initializes the central store before hooks and starts retention asynchronously', async () => {
    const db = { dialect: 'postgres' };
    await initAuditLog({ db, signal: new AbortController().signal } as never);
    expect(mocks.initializeAuditPseudonymizer).toHaveBeenCalledWith('/private/test-key');
    expect(mocks.initializeAuditStore).toHaveBeenCalledWith(db);
    await vi.waitFor(() => expect(mocks.pruneAuditLogIfDue).toHaveBeenCalledOnce());
    expect(mocks.initAuditHooks).toHaveBeenCalledOnce();
    expect(mocks.state.shutdown).not.toBeNull();
    await mocks.state.shutdown?.();
    expect(mocks.closeAuditWriteAdmissionAndWait).toHaveBeenCalledOnce();
    expect(mocks.shutdownAuditStdout).toHaveBeenCalledOnce();
    expect(mocks.shutdownAuditHooks).toHaveBeenCalledOnce();
    expect(mocks.closeAuditWriteAdmissionAndWait.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.shutdownAuditStdout.mock.invocationCallOrder[0],
    );
    expect(mocks.shutdownAuditStdout.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.shutdownAuditHooks.mock.invocationCallOrder[0],
    );
  });
});
