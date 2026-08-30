import { describe, it, expect, afterEach, vi } from 'vitest';

import type { Session } from '../../types.js';

const wakeContainer = vi.fn();
const honorPendingStopIntents = vi.fn();
vi.mock('../../container-runner.js', () => ({
  wakeContainer: (session: Session) => wakeContainer(session),
  honorPendingStopIntents: () => honorPendingStopIntents(),
}));

const session = { id: 's-1', agent_group_id: 'g-1' } as Session;

type Round = {
  roleModule: typeof import('./role.js');
  crossPlane: typeof import('./cross-plane.js');
  db: typeof import('../../db/index.js');
  feeds: typeof import('../../reconcile-feeds.js');
};

let lastRound: Round | null = null;

/**
 * Import the overlay fresh under a given NANOCLAW_ROLE. `vi.resetModules`
 * resets EVERY module — including the DB registry — so each round owns its
 * whole world: all DB setup and assertions must go through the round's own
 * handles, never through top-level imports.
 */
async function withRole(role: string | undefined, initDb = true): Promise<Round> {
  vi.resetModules();
  vi.stubEnv('NANOCLAW_ROLE', role ?? '');
  const roleModule = await import('./role.js');
  const crossPlane = await import('./cross-plane.js');
  const db = await import('../../db/index.js');
  const feeds = await import('../../reconcile-feeds.js');
  if (initDb) {
    const driver = await db.initSqliteTestDb();
    await db.runMigrations(driver);
  }
  lastRound = { roleModule, crossPlane, db, feeds };
  return lastRound;
}

afterEach(async () => {
  wakeContainer.mockReset();
  honorPendingStopIntents.mockReset();
  vi.unstubAllEnvs();
  if (lastRound) {
    lastRound.feeds.registerReconcileEnqueue(null);
    await lastRound.db.closeDb().catch(() => undefined);
    lastRound = null;
  }
});

describe('boot role', () => {
  it("defaults to 'all' — every plane predicate true, split predicates false", async () => {
    const { roleModule } = await withRole(undefined, false);
    expect(roleModule.HOST_ROLE).toBe('all');
    expect(roleModule.gatewayPlane()).toBe(true);
    expect(roleModule.controllerPlane()).toBe(true);
    expect(roleModule.isSplitGateway()).toBe(false);
    expect(roleModule.isSplitController()).toBe(false);
  });

  it('the readiness marker is written by the split gateway alone', async () => {
    const fs = await import('fs');
    const { roleModule: gateway } = await withRole('gateway', false);
    fs.rmSync(gateway.GATEWAY_READY_MARKER, { force: true });
    gateway.markGatewayReady();
    expect(fs.existsSync(gateway.GATEWAY_READY_MARKER)).toBe(true);
    fs.rmSync(gateway.GATEWAY_READY_MARKER, { force: true });

    // Every other role is a no-op — the marker is the split gateway's signal.
    const { roleModule: all } = await withRole(undefined, false);
    all.markGatewayReady();
    expect(fs.existsSync(all.GATEWAY_READY_MARKER)).toBe(false);
  });

  it('rejects an unknown role at import — half a plane is worse than no process', async () => {
    await expect(withRole('gatway', false)).rejects.toThrow(/NANOCLAW_ROLE/);
  });
});

describe('requestWakeForPlane', () => {
  it("role 'all' is the trunk delegation verbatim — wake called, no signal row", async () => {
    const { crossPlane, db } = await withRole(undefined);
    wakeContainer.mockResolvedValueOnce(true);
    expect(await crossPlane.requestWakeForPlane(session, 'inbound-message')).toBe(true);
    expect(wakeContainer).toHaveBeenCalledWith(session);
    expect(await db.takeWakeSignals({ consumerId: 't', now: new Date().toISOString() })).toHaveLength(0);
  });

  it('the split gateway writes a durable signal and never touches the runtime', async () => {
    const { crossPlane, db } = await withRole('gateway');
    expect(await crossPlane.requestWakeForPlane(session, 'inbound-message')).toBe(true);
    expect(wakeContainer).not.toHaveBeenCalled();
    const signals = await db.takeWakeSignals({ consumerId: 't', now: new Date().toISOString() });
    expect(signals.map((signal) => [signal.session_id, signal.reason])).toEqual([['s-1', 'inbound-message']]);
  });

  it('the split controller delegates like the trunk seam', async () => {
    const { crossPlane } = await withRole('controller');
    wakeContainer.mockResolvedValueOnce(false);
    expect(await crossPlane.requestWakeForPlane(session, 'due-message')).toBe(false);
    expect(wakeContainer).toHaveBeenCalledWith(session);
  });
});

describe('wake-signal consumer', () => {
  it('takes each signal exactly once and enqueues its session for reconcile', async () => {
    const { crossPlane, db, feeds } = await withRole('controller');
    await db.writeWakeSignal('s-1', 'inbound-message', new Date().toISOString());
    await db.writeWakeSignal('s-2', 'approval-response', new Date().toISOString());

    const enqueued: string[] = [];
    feeds.registerReconcileEnqueue((sessionId) => enqueued.push(sessionId));
    await crossPlane.consumeOnce();
    expect(enqueued.sort()).toEqual(['s-1', 's-2']);

    // A second pass finds nothing — consume-once semantics held.
    await crossPlane.consumeOnce();
    expect(enqueued).toHaveLength(2);
  });

  it('honors durable stop intents — the cross-plane restart channel', async () => {
    const { crossPlane, db } = await withRole('controller');
    await crossPlane.consumeOnce();
    expect(honorPendingStopIntents).not.toHaveBeenCalled();

    await db.setStopIntent('s-9', 'respawn_after_stop', new Date().toISOString());
    await crossPlane.consumeOnce();
    expect(honorPendingStopIntents).toHaveBeenCalledTimes(1);
  });
});

describe('gateway schema wait', () => {
  it('retries validation until the migrator finishes, then proceeds', async () => {
    const { crossPlane } = await withRole('gateway', false);
    let calls = 0;
    await crossPlane.awaitSchemaCurrent(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('schema_version behind');
      },
      { retryMs: 5, maxTries: 10 },
    );
    expect(calls).toBe(3);
  });

  it('gives up with a clear error when no migrator ever runs', async () => {
    const { crossPlane } = await withRole('gateway', false);
    await expect(
      crossPlane.awaitSchemaCurrent(
        async () => {
          throw new Error('schema_version behind');
        },
        { retryMs: 1, maxTries: 3 },
      ),
    ).rejects.toThrow(/schema never became current.*schema_version behind/s);
  });
});
