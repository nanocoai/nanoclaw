import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queued = vi.hoisted(() => ({
  batch: {
    batch: {
      schema_version: 'nanoco.host-audit.v1',
      host_id: 'Prod.EU:Host-01',
      items: [
        {
          event: {
            schema_version: 'nanoco.host-audit.v1',
            event_id: '00000000-0000-4000-8000-000000000001',
            host_id: 'Prod.EU:Host-01',
            seq: 1,
            occurred_at: '2026-08-23T10:00:00.000Z',
            event_type: 'ncl_action',
            provenance: 'host-observed',
            actor: { type: 'system', id: 'test' },
            agent_id: null,
            session_id: null,
            dimensions: {},
          },
        },
      ],
    },
    body: Buffer.from('{}'),
    firstSeq: 1,
    lastSeq: 1,
  },
}));

vi.mock('./config.js', () => ({
  HOST_AUDIT_GOVERNANCE_URL: 'not-a-valid-url',
  HOST_AUDIT_BEARER_TOKEN_FILE: '',
  HOST_AUDIT_TLS_CERT: '',
  HOST_AUDIT_TLS_KEY: '',
  HOST_AUDIT_TLS_CA: '',
}));
vi.mock('./store.js', () => ({
  getAuditStore: () => ({
    acknowledgedThrough: async () => 0,
    advanceAcknowledgement: vi.fn(async () => undefined),
  }),
}));
vi.mock('./governance-queue.js', () => ({
  streamGovernanceBatches: async function* () {
    yield queued.batch;
  },
}));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

describe('Governance drain lifecycle isolation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('isolates a configured endpoint failure during the registered shutdown flush', async () => {
    await import('./governance-drain.js');
    const hooks = await import('./hooks.js');
    const { log } = await import('../log.js');
    hooks.initAuditHooks();

    await expect(hooks.shutdownAuditHooks()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('shutdown failed'),
      expect.objectContaining({ hook: 'governance-host-audit-drain' }),
    );
  });
});
