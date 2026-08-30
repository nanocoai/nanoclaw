/**
 * Claim readiness push (D18) — the subscriber over the service's events.
 *
 * Exactly-once is the state machine's own discipline, and these cases pin it
 * where it matters: one push per terminal transition, none on re-adoption of
 * an already-settled env, exactly one across a restart's resumeClaim
 * re-adoption — and a failed push carries the recorded reason (#20). The
 * delivery seam is injected; the production transport (the approvals
 * session-message path) is exercised only for its skip-on-missing-session
 * posture, because everything under it is the approvals machinery's proven
 * ground.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import type { DbDriver } from '../db/driver.js';
import { runMigrations } from '../db/migrations/index.js';

import { deliverClaimPushToSession, wireClaimReadinessPush } from './claim-notify.js';
// Side-effect: registers the dev-env migrations — claimant_session_id rides them.
import './index.js';
import { MockDevEnvDriver, MockDevEnvRuntime, instanceName } from './mock-driver.js';
import { DevEnvService, type EnvSnapshot } from './service.js';

const INSTALL = 'claim-notify-suite';
const STAMP = 'sample-app';
const SESSION = 's-claimant';

interface Push {
  sessionId: string;
  text: string;
}

interface Fixture {
  db: DbDriver;
  runtime: MockDevEnvRuntime;
  /** A "host": service + wired push. Call again to simulate a restart. */
  host(opts?: { manual?: boolean; resolveStampVersion?: () => Promise<number | null> }): {
    service: DevEnvService;
    driver: MockDevEnvDriver;
    pushes: Push[];
  };
}

let fx: Fixture;
beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  const runtime = new MockDevEnvRuntime();
  fx = {
    db,
    runtime,
    host(opts = {}) {
      const driver = new MockDevEnvDriver({
        installScope: INSTALL,
        runtime,
        knownStamps: [STAMP],
        manualCompletion: opts.manual ?? false,
      });
      const service = new DevEnvService({
        db,
        driver,
        installScope: INSTALL,
        resolveStampVersion: opts.resolveStampVersion,
      });
      const pushes: Push[] = [];
      wireClaimReadinessPush(service, async (sessionId, text) => {
        pushes.push({ sessionId, text });
      });
      return { service, driver, pushes };
    },
  };
});
afterEach(async () => {
  await closeDb();
});

/** Same tick discipline as the registry suite: settles are registry I/O behind a sync callback. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function boot(env: EnvSnapshot): void {
  fx.runtime.complete(instanceName({ envId: env.envId, instanceId: env.instanceId! }));
}

/** The instance dies while nobody is listening — what "while the host was down" means. */
function dieSilently(env: EnvSnapshot): void {
  fx.runtime.instances.delete(instanceName({ envId: env.envId, instanceId: env.instanceId! }));
}

describe('the push on a settling claim', () => {
  it('an async claim pushes exactly once on active — env id, stamp, state, and the endpoints to connect to', async () => {
    const { service, pushes } = fx.host({ manual: true });
    const env = await service.claim({
      ownerRef: 'g1',
      stampId: STAMP,
      lifetime: { mode: 'pinned' },
      claimantSessionId: SESSION,
    });
    expect(env.state).toBe('claiming');
    expect(env.claimantSessionId).toBe(SESSION); // armed — the claim response promises the push on this

    boot(env);
    await settled();

    expect(pushes).toHaveLength(1);
    expect(pushes[0].sessionId).toBe(SESSION);
    expect(pushes[0].text).toContain(env.envId);
    expect(pushes[0].text).toContain('active');
    expect(pushes[0].text).toContain(`stamp ${STAMP}`);
    // The connection essentials ride the push itself, not a mandated second hop.
    expect(pushes[0].text).toMatch(/endpoints: app=http:/);
  });

  it('a warm claim answers synchronously and never arms the push — the response already said active', async () => {
    const { service, pushes } = fx.host();
    const env = await service.claim({
      ownerRef: 'g1',
      stampId: STAMP,
      lifetime: { mode: 'pinned' },
      claimantSessionId: SESSION,
    });
    expect(env.state).toBe('active');
    expect(env.claimantSessionId).toBeNull();

    await settled();
    expect(pushes).toHaveLength(0);
  });

  it('a claim with no claimant session settles silently — host claims keep the poll contract', async () => {
    const { service, pushes } = fx.host({ manual: true });
    const env = await service.claim({ ownerRef: 'operator', stampId: STAMP, lifetime: { mode: 'pinned' } });

    boot(env);
    await settled();

    expect((await service.status(env.envId)).state).toBe('active');
    expect(pushes).toHaveLength(0);
  });

  it('a failed provisioning pushes once, carrying the recorded reason (#20) and the stamp@version provenance', async () => {
    const { service, pushes } = fx.host({ manual: true, resolveStampVersion: async () => 3 });
    const env = await service.claim({
      ownerRef: 'g1',
      stampId: STAMP,
      lifetime: { mode: 'pinned' },
      claimantSessionId: SESSION,
    });

    fx.runtime.failProvisioning(instanceName({ envId: env.envId, instanceId: env.instanceId! }), {
      kind: 'instantiation-failed',
      retryable: false,
      detail: 'vcluster kubeconfig secret never appeared',
    });
    await settled();

    expect(pushes).toHaveLength(1);
    expect(pushes[0].sessionId).toBe(SESSION);
    expect(pushes[0].text).toContain('failed');
    expect(pushes[0].text).toContain('instantiation-failed: vcluster kubeconfig secret never appeared');
    expect(pushes[0].text).toContain(`stamp ${STAMP}@v3`);
  });

  it('a synchronous refusal pushes nothing — the thrown claim itself carried the failure', async () => {
    const { service, driver, pushes } = fx.host();
    driver.failNextClaim({ kind: 'capacity-exhausted', retryable: true });

    await expect(
      service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' }, claimantSessionId: SESSION }),
    ).rejects.toMatchObject({ kind: 'capacity-exhausted' });
    await settled();

    expect(pushes).toHaveLength(0);
  });

  it("release pushes nothing — the ending is the caller's own act", async () => {
    const { service, pushes } = fx.host({ manual: true });
    const env = await service.claim({
      ownerRef: 'g1',
      stampId: STAMP,
      lifetime: { mode: 'pinned' },
      claimantSessionId: SESSION,
    });
    boot(env);
    await settled();
    expect(pushes).toHaveLength(1);

    await service.release(env.envId);
    await settled();
    expect(pushes).toHaveLength(1);
  });

  it('an armed active env that later dies pushes that too — one push per terminal transition', async () => {
    const { service, pushes } = fx.host({ manual: true });
    const env = await service.claim({
      ownerRef: 'g1',
      stampId: STAMP,
      lifetime: { mode: 'pinned' },
      claimantSessionId: SESSION,
    });
    boot(env);
    await settled();

    fx.runtime.kill(instanceName({ envId: env.envId, instanceId: env.instanceId! }));
    await settled();

    expect(pushes).toHaveLength(2);
    expect(pushes[1].text).toContain('instance-died');
  });
});

describe('exactly-once across a host restart', () => {
  it('a claim re-adopted in flight (resumeClaim) pushes exactly once, from the new host', async () => {
    const first = fx.host({ manual: true });
    const env = await first.service.claim({
      ownerRef: 'g1',
      stampId: STAMP,
      lifetime: { mode: 'pinned' },
      claimantSessionId: SESSION,
    });
    expect(env.state).toBe('claiming');

    fx.runtime.severListeners(); // the first host is dead — its handles stop observing
    const second = fx.host({ manual: true });
    await second.service.adopt(); // resume converges; the armed row rode the registry across
    boot(env);
    await settled();

    expect(second.pushes).toHaveLength(1);
    expect(second.pushes[0].sessionId).toBe(SESSION);
    expect(first.pushes).toHaveLength(0);
  });

  it('re-adoption of an already-active env pushes nothing — no transition, no message', async () => {
    const first = fx.host({ manual: true });
    const env = await first.service.claim({
      ownerRef: 'g1',
      stampId: STAMP,
      lifetime: { mode: 'pinned' },
      claimantSessionId: SESSION,
    });
    boot(env);
    await settled();
    expect(first.pushes).toHaveLength(1); // the one true push, pre-restart

    fx.runtime.severListeners();
    const second = fx.host({ manual: true });
    await second.service.adopt();
    await settled();

    expect((await second.service.status(env.envId)).state).toBe('active');
    expect(second.pushes).toHaveLength(0);
  });

  it('a claim whose instance died with the host pushes its failure on adoption, reason included', async () => {
    const first = fx.host({ manual: true });
    const env = await first.service.claim({
      ownerRef: 'g1',
      stampId: STAMP,
      lifetime: { mode: 'pinned' },
      claimantSessionId: SESSION,
    });
    dieSilently(env);

    fx.runtime.severListeners();
    const second = fx.host({ manual: true });
    await second.service.adopt();
    await settled();

    expect(second.pushes).toHaveLength(1);
    expect(second.pushes[0].text).toContain('host restarted mid-claim');
  });
});

describe('the production transport', () => {
  it('skips a session that no longer exists — the row and the poll path still hold the truth', async () => {
    // getSession over the migrated trunk table answers undefined; the deliver
    // must settle without touching notifyAgent (nothing to wake, nothing to throw).
    await expect(deliverClaimPushToSession('s-long-gone', 'Dev env env-x is active')).resolves.toBeUndefined();
  });
});
