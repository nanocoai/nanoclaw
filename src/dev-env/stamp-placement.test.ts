/**
 * The C15 placement reconciler, the approve-to-place claim gate, and the
 * placement push — the whoami-shaped acceptance arc as far as fakes allow:
 * approved pull row → claim refused IN the approve-to-place window with the
 * brief's refusal shape (seconds, never a boot timeout) → reconciler places
 * the signed digest → gate opens → claim active → provenance chains. Plus
 * the legs the brief names: failure with the registry's words on the row,
 * re-place without a new approval, host-death adoption with NO age gate, and
 * the eviction re-probe closing the gate honestly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import type { DbDriver } from '../db/driver.js';
import { runMigrations } from '../db/migrations/index.js';

// Side-effect: registers the dev-env migrations.
import './index.js';
import { MockDevEnvDriver, MockDevEnvRuntime } from './mock-driver.js';
import { DevEnvService } from './service.js';
import { StampImageStore, placeRef } from './stamp-images.js';
import { StampPlacementReconciler, makeStampImageGate, wireStampPlacementPush } from './stamp-placement.js';
import { RegistryStampSource, StampRegistryStore } from './stamp-registry.js';
import type { K8sStampConfig } from './stamps.js';
import type { DriverPlaceSpec } from './types.js';

const INSTALL = 'placement-suite';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const SOURCE_REF = `ghcr.example.invalid/org/whoami:1@${DIGEST}`;
const PULL: K8sStampConfig = { app: { image: SOURCE_REF, port: 8080 } };

/** The mock driver, grown the two placement verbs — a store the tests can evict from. */
class PlacingMockDriver extends MockDevEnvDriver {
  readonly placeCalls: DriverPlaceSpec[] = [];
  readonly store = new Set<string>();
  nextPlaceError: string | null = null;

  async placeImage(spec: DriverPlaceSpec): Promise<{ storeId: string }> {
    this.placeCalls.push(spec);
    if (this.nextPlaceError) {
      const message = this.nextPlaceError;
      this.nextPlaceError = null;
      throw new Error(message);
    }
    this.store.add(spec.ref);
    return { storeId: spec.origin.digest };
  }

  async probeImage(ref: string): Promise<boolean> {
    return this.store.has(ref);
  }
}

let db: DbDriver;
let images: StampImageStore;
let registry: StampRegistryStore;
let source: RegistryStampSource;
let runtime: MockDevEnvRuntime;
let driver: PlacingMockDriver;
let service: DevEnvService;
let reconciler: StampPlacementReconciler;
let pushes: Array<{ sessionId: string; text: string }>;

beforeEach(async () => {
  db = await initTestDb();
  await runMigrations(db);
  images = new StampImageStore(db);
  registry = new StampRegistryStore(db, () => ['sample-app', 'nanoclaw']);
  source = new RegistryStampSource(registry, undefined, images);
  runtime = new MockDevEnvRuntime();
  driver = new PlacingMockDriver({ installScope: INSTALL, runtime, knownStamps: ['whoami', 'local-app', 'stack'] });
  service = new DevEnvService({
    db,
    driver,
    installScope: INSTALL,
    resolveStampVersion: async (stampId) => (await registry.get(stampId))?.version ?? null,
    imageGate: makeStampImageGate({ registry, images, reservedIds: () => ['sample-app', 'nanoclaw'] }),
  });
  reconciler = new StampPlacementReconciler({ images, registry, driver, installScope: INSTALL, source });
  pushes = [];
  wireStampPlacementPush(reconciler, async (sessionId, text) => {
    pushes.push({ sessionId, text });
  });
});

afterEach(async () => {
  await closeDb();
});

/** What the approved CLI handler does: the row, then its pending ledger entry. */
async function approvePullStamp(stampId = 'whoami', sessionId: string | null = null): Promise<void> {
  await registry.create({ stampId, config: PULL, authorRef: 'g1' });
  await images.insertPending({
    stampId,
    version: 1,
    origin: 'pull',
    ref: placeRef(stampId, 1),
    sourceRef: SOURCE_REF,
    claimantSessionId: sessionId,
  });
  await source.refresh();
}

function claim(stampId = 'whoami') {
  return service.claim({ ownerRef: 'g-agent', stampId, lifetime: { mode: 'pinned' } });
}

describe('the approve-to-place gate (#22)', () => {
  it('refuses a claim in the approve-to-place window with the exact shape — state + started, never a timeout', async () => {
    await approvePullStamp();
    await expect(claim()).rejects.toThrow(
      /image for 'whoami' v1 is pending \(started .*\) — claimable when stamps get shows placed/,
    );
    // No env row was minted for the refused claim — this was an input
    // refusal, not an env that failed.
    expect(await service.list({})).toEqual([]);
  });

  it('says `placing` while the pull is in flight, and carries the recorded reason once failed', async () => {
    await approvePullStamp();
    await images.markPlacing('whoami', 1);
    await expect(claim()).rejects.toThrow(/is placing \(started/);
    await images.markFailed('whoami', 1, '401 Unauthorized: authentication required');
    await expect(claim()).rejects.toThrow(/401 Unauthorized.*stamps place whoami/s);
  });

  it('an approved registry stamp with NO record answers the predates-the-path refusal, not a fake pending', async () => {
    await registry.create({ stampId: 'whoami', config: PULL, authorRef: 'g1' });
    await source.refresh();
    await expect(claim()).rejects.toThrow(/no placement record/);
  });

  it('stays out of the way for node-local stamps, builtins, and unknown ids', async () => {
    await registry.create({
      stampId: 'local-app',
      config: { app: { image: 'whoami:local', presence: 'node-local', port: 80 } },
      authorRef: 'g1',
    });
    await source.refresh();
    await expect(claim('local-app')).resolves.toMatchObject({ state: 'active' }); // no gate, no rows
    // Unknown id: the driver's own refusal is the honest one — the gate must
    // not shadow it with an image answer about a stamp that does not exist.
    await expect(claim('ghost')).rejects.toThrow(/stamp-unknown/);
  });

  /**
   * The node-local half of the same gate: a childManifests stamp's images
   * arrive by operator hand, and a missing one used to be a ten-minute boot
   * budget spent on ImagePullBackOff read as "not Available yet".
   */
  describe('declared node images', () => {
    const STACK: K8sStampConfig = {
      childManifests: '{"kind":"Namespace","metadata":{"name":"x"}}',
      readiness: { deployment: 'host', namespace: 'x' },
      nodeImages: ['child-host:v06', 'gw:v12'],
    };

    function gateWith(missing: string[]): DevEnvService {
      return new DevEnvService({
        db,
        driver,
        installScope: INSTALL,
        imageGate: makeStampImageGate({
          registry,
          images,
          reservedIds: () => ['sample-app', 'nanoclaw'],
          codeProvided: (id) => (id === 'nanoclaw' ? STACK : undefined),
          probeNodeImages: async (refs) => refs.filter((ref) => missing.includes(ref)),
        }),
      });
    }

    it('refuses BY NAME in seconds, naming what to import — never a boot timeout', async () => {
      await registry.create({ stampId: 'stack', config: STACK, authorRef: 'g1' });
      await source.refresh();
      const svc = gateWith(['gw:v12']);
      await expect(
        svc.claim({ ownerRef: 'g-agent', stampId: 'stack', lifetime: { mode: 'pinned' } }),
      ).rejects.toThrow(/missing 1: gw:v12 — nothing pulls at claim time/);
      expect(await svc.list({})).toEqual([]); // an input refusal, not an env that failed
    });

    it('gates a CODE-PROVIDED stamp too — the mute failure this closes was a builtin’s', async () => {
      const svc = gateWith(['child-host:v06']);
      await expect(
        svc.claim({ ownerRef: 'g-agent', stampId: 'nanoclaw', lifetime: { mode: 'pinned' } }),
      ).rejects.toThrow(/child-host:v06/);
    });

    it('lets the claim through once the node holds them, and when the probe cannot answer', async () => {
      await registry.create({ stampId: 'stack', config: STACK, authorRef: 'g1' });
      await source.refresh();
      await expect(
        gateWith([]).claim({ ownerRef: 'g-agent', stampId: 'stack', lifetime: { mode: 'pinned' } }),
      ).resolves.toMatchObject({ stampId: 'stack' });

      const blind = new DevEnvService({
        db,
        driver,
        installScope: INSTALL,
        imageGate: makeStampImageGate({
          registry,
          images,
          reservedIds: () => ['sample-app', 'nanoclaw'],
          probeNodeImages: async () => {
            throw new Error('The connection to the server was refused');
          },
        }),
      });
      await expect(
        blind.claim({ ownerRef: 'g-agent', stampId: 'stack', lifetime: { mode: 'pinned' } }),
      ).resolves.toMatchObject({ stampId: 'stack' });
    });
  });
});

describe('the reconciler', () => {
  it('places the oldest pending row: pending → placing → placed, gate opens, claim goes active', async () => {
    await approvePullStamp();
    await reconciler.tick();
    expect((await images.get('whoami', 1))!).toMatchObject({ state: 'placed', digest: DIGEST });
    const env = await claim();
    expect(env.state).toBe('active');
    expect(env.stampVersion).toBe(1); // the chain: env → stamp@v1 → digest → registry ref
  });

  it('places EXACTLY the digest approval signed — never a re-resolution — on first place and on re-place', async () => {
    await approvePullStamp();
    driver.nextPlaceError = 'registry unreachable: dial tcp: i/o timeout';
    await reconciler.tick();
    expect((await images.get('whoami', 1))!).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('registry unreachable'),
    });
    // Recovery needs no new approval: the signed digest never changed.
    await images.resetToPending('whoami', 1);
    await reconciler.tick();
    expect((await images.get('whoami', 1))!.state).toBe('placed');
    // Both attempts carried the approval-seen digest and the derived ref.
    expect(driver.placeCalls.map((c) => c.origin.digest)).toEqual([DIGEST, DIGEST]);
    expect(driver.placeCalls.every((c) => c.ref === 'place.nanoclaw.invalid/stamp/whoami:v1')).toBe(true);
    expect(driver.placeCalls.every((c) => c.origin.sourceRef === SOURCE_REF)).toBe(true);
  });

  it('pool sizes omit unplaced pull stamps and include them once placed', async () => {
    await approvePullStamp();
    await registry.setPool('whoami', 2);
    await source.refresh();
    expect(source.poolSizes()).toEqual({});
    await reconciler.tick();
    expect(source.poolSizes()).toEqual({ whoami: 2 });
  });

  it('re-probes placed rows: an evicted image closes the gate honestly and re-places the identical digest', async () => {
    await approvePullStamp();
    await reconciler.tick();
    driver.store.clear(); // kubelet GC'd it
    await reconciler.tick();
    // The flip happened in the same tick; the row either re-placed already
    // (concurrency-1: same tick takes it as the oldest pending) — assert the
    // full heal landed the same bits.
    expect((await images.get('whoami', 1))!).toMatchObject({ state: 'placed', digest: DIGEST });
    expect(driver.placeCalls).toHaveLength(2);
    expect(driver.placeCalls[1].origin.digest).toBe(DIGEST);
  });

  it('adoption fails ALL placing rows with the host-lost reason — no age gate — and place recovers', async () => {
    await approvePullStamp();
    await images.markPlacing('whoami', 1); // the host died holding this
    await reconciler.adopt();
    const row = (await images.get('whoami', 1))!;
    expect(row.state).toBe('failed');
    expect(row.error).toContain('host restarted mid-placement');
    await images.resetToPending('whoami', 1);
    await reconciler.tick();
    expect((await images.get('whoami', 1))!.state).toBe('placed');
  });

  it('fails a queue head it cannot spec rather than wedging the concurrency-1 queue behind it', async () => {
    await registry.create({ stampId: 'whoami', config: PULL, authorRef: 'g1' });
    await images.insertPending({
      stampId: 'whoami',
      version: 1,
      origin: 'pull',
      ref: placeRef('whoami', 1),
      sourceRef: 'ghcr.example.invalid/org/whoami:1', // no digest — a row nothing signed
    });
    await reconciler.tick();
    expect((await images.get('whoami', 1))!).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('no signed digest'),
    });
  });
});

describe('the placement push (#223 seam, same transport)', () => {
  it('notifies the registering session on placed and on failed, reason riding the failure', async () => {
    await approvePullStamp('whoami', 's-author');
    driver.nextPlaceError = 'manifest unknown: tag deleted upstream';
    await reconciler.tick();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ sessionId: 's-author' });
    expect(pushes[0].text).toContain('placement failed');
    expect(pushes[0].text).toContain('manifest unknown');

    await images.resetToPending('whoami', 1);
    await reconciler.tick();
    expect(pushes).toHaveLength(2);
    expect(pushes[1].text).toContain(`image placed — pulled from ${SOURCE_REF}`);
    expect(pushes[1].text).toContain('ncl envs claim --stamp whoami');
  });

  it('notifies nobody when no session is recorded — the operator polls', async () => {
    await approvePullStamp('whoami', null);
    await reconciler.tick();
    expect(pushes).toEqual([]);
  });

  it('adoption failures reach the waiting session too — a claim armed before the crash is still told', async () => {
    await approvePullStamp('whoami', 's-author');
    await images.markPlacing('whoami', 1);
    await reconciler.adopt();
    expect(pushes).toHaveLength(1);
    expect(pushes[0].text).toContain('host restarted mid-placement');
  });
});
