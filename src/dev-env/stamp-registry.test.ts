/**
 * The stamps registry (C12): stamps as rows.
 *
 * Proves the three properties the registry exists for:
 * - registration earns the driver-constructor refusals AT THE WRITE — an
 *   invalid manifest is refused with the exact message, never a boot timeout
 * - definitions are versioned and provenance-shaped: updates increment,
 *   retire preserves, code-provided ids are never shadowable
 * - the source is a sync snapshot of an async store: probe paths read what
 *   the last refresh loaded, and an invalid row is EXCLUDED loudly rather
 *   than crashing the refresh
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import type { DbDriver } from '../db/driver.js';
import { runMigrations } from '../db/migrations/index.js';
import { startHostModules, stopHostModules } from '../host-lifecycle.js';

import { registerDevEnvDriver } from './driver-registry.js';
// Side-effect: registers the dev-env migrations (envs + stamp registry) — and
// the host-start hook the boot-snapshot suite below drives for real.
import { getStampRegistry } from './index.js';
import { RegistryStampSource, StampRegistryStore } from './stamp-registry.js';
import type { K8sStampConfig } from './stamps.js';

const APP: K8sStampConfig = { app: { image: 'example.invalid/app:1', presence: 'node-local', port: 8080 } };
const CHILD: K8sStampConfig = {
  childManifests: '{"kind":"Namespace"}',
  readiness: { deployment: 'my-app', namespace: 'default' },
};

let db: DbDriver;
let store: StampRegistryStore;

beforeEach(async () => {
  db = await initTestDb();
  await runMigrations(db);
  store = new StampRegistryStore(db, () => ['nanoclaw', 'sample-app']);
});

afterEach(async () => {
  await closeDb();
});

describe('the store', () => {
  it('registers, versions on update, and answers claims-shaped reads', async () => {
    const created = await store.create({ stampId: 'my-app', config: CHILD, authorRef: 'g1', source: { repo: 'r' } });
    expect(created).toMatchObject({ stampId: 'my-app', version: 1, state: 'active', poolSize: 0, authorRef: 'g1' });

    const updated = await store.update('my-app', { ...CHILD, childManifests: '{"kind":"ConfigMap"}' });
    expect(updated.version).toBe(2);
    expect(updated.source).toEqual({ repo: 'r' }); // COALESCE: absent source keeps the old provenance

    expect((await store.list({ state: 'active' })).map((r) => r.stampId)).toEqual(['my-app']);
  });

  it('earns the constructor refusals at the write, with the exact messages', async () => {
    // The full matrix lives with validateStampEntry; this pins that the store
    // ROUTES through it on both write paths — registration is where the
    // approving human sees the refusal.
    await expect(store.create({ stampId: 'My App', config: APP, authorRef: 'g1' })).rejects.toThrow(
      /stamp id must be k8s-label-legal/,
    );
    await expect(
      store.create({ stampId: 'half', config: { childManifests: '{}' }, authorRef: 'g1' }),
    ).rejects.toThrow(/must declare readiness/);
    await store.create({ stampId: 'ok', config: APP, authorRef: 'g1' });
    await expect(store.update('ok', { readiness: { deployment: 'x', namespace: 'default' } })).rejects.toThrow(
      /readiness without childManifests/,
    );
  });

  it('never lets a row shadow a code-provided stamp, and refuses duplicates', async () => {
    await expect(store.create({ stampId: 'nanoclaw', config: APP, authorRef: 'g1' })).rejects.toThrow(
      /code-provided on this deployment/,
    );
    await store.create({ stampId: 'mine', config: APP, authorRef: 'g1' });
    await expect(store.create({ stampId: 'mine', config: APP, authorRef: 'g2' })).rejects.toThrow(/already exists/);
  });

  it('retire preserves the row, drains the pool, and blocks update + repool', async () => {
    await store.create({ stampId: 'gone', config: APP, authorRef: 'g1' });
    await store.setPool('gone', 2);
    const retired = await store.retire('gone');
    expect(retired).toMatchObject({ state: 'retired', poolSize: 0 });
    // The row survives — claims recorded its version, and the ledger must
    // keep answering for them.
    expect(await store.get('gone')).toBeDefined();
    await expect(store.update('gone', APP)).rejects.toThrow(/retired/);
    await expect(store.setPool('gone', 1)).rejects.toThrow(/retired/);
    await expect(store.setPool('gone', 0)).resolves.toBeDefined(); // zero stays legal
  });

  it('set-pool refuses anything but a non-negative integer', async () => {
    await store.create({ stampId: 'p', config: APP, authorRef: 'g1' });
    await expect(store.setPool('p', -1)).rejects.toThrow(/non-negative integer/);
    await expect(store.setPool('p', 1.5)).rejects.toThrow(/non-negative integer/);
    await expect(store.setPool('missing', 1)).rejects.toThrow(/no stamp/);
  });
});

describe('the source', () => {
  it('answers sync reads from the last refresh, active rows only', async () => {
    const source = new RegistryStampSource(store);
    await store.create({ stampId: 'a', config: APP, authorRef: 'g1' });
    await store.create({ stampId: 'b', config: CHILD, authorRef: 'g1' });
    await store.setPool('a', 3);
    await store.retire('b');

    expect(source.getStamp('a')).toBeUndefined(); // cold snapshot: nothing yet
    await source.refresh();
    expect(source.getStamp('a')).toEqual(APP);
    expect(source.stampVersion('a')).toBe(1);
    expect(source.getStamp('b')).toBeUndefined(); // retired rows never enter the table
    // ...but the source remembers WHICH ids are retired, so a claim's refusal
    // can say 'retired' instead of 'no such stamp' (ISSUES #21).
    expect(source.retiredStamp('b')).toBe(true);
    expect(source.retiredStamp('never-registered')).toBe(false);
    expect(source.poolSizes()).toEqual({ a: 3 });
  });

  it('excludes an invalid row loudly instead of crashing the refresh', async () => {
    // A row that predates a validation rule: written straight to the table,
    // past the store's create-time checks.
    await db.run(
      `INSERT INTO stamp_registry (stamp_id, config, pool_size, version, state, author_ref, created_at, updated_at)
       VALUES ('legacy', '{"childManifests":"{}"}', 1, 1, 'active', 'g1', 't', 't')`,
    );
    await store.create({ stampId: 'fine', config: APP, authorRef: 'g1' });
    const complaints: string[] = [];
    const source = new RegistryStampSource(store, (id) => complaints.push(id));
    await source.refresh();
    expect(source.getStamp('legacy')).toBeUndefined();
    expect(source.poolSizes()).toEqual({}); // its pool must not fill either
    expect(source.getStamp('fine')).toEqual(APP);
    expect(source.invalid()).toEqual(['legacy']);
    expect(complaints).toEqual(['legacy']);
  });

  it('omits a stamp whose declared node image is not on the node — one probe for the whole table', async () => {
    // A pool fill for an image the node does not hold spends a whole boot
    // budget discovering ImagePullBackOff, which the warm gate can only read
    // as "not Available yet". The declaration is what turns that into an
    // omission the operator can see in `stamps list`.
    await store.create({
      stampId: 'stack',
      config: { ...CHILD, nodeImages: ['child-host:v06', 'gw:v12'] },
      authorRef: 'g1',
    });
    await store.setPool('stack', 2);
    await store.create({ stampId: 'plain', config: CHILD, authorRef: 'g1' });
    await store.setPool('plain', 1);

    const asked: string[][] = [];
    const missing = new Set(['gw:v12']);
    const source = new RegistryStampSource(store, () => {}, null, () => async (refs) => {
      asked.push(refs);
      return refs.filter((ref) => missing.has(ref));
    });
    await source.refresh();
    expect(source.poolSizes()).toEqual({ plain: 1 });
    expect(asked).toEqual([['child-host:v06', 'gw:v12']]); // one call, the union of the table's declarations
    // The gate has STANDING STATE, because closing it drains warm slots: the
    // row says which image is missing, and a row that declares none says
    // nothing at all rather than a hollow "present".
    expect(source.nodeImageStatus('stack')).toEqual({ missing: ['gw:v12'], checked: true });
    expect(source.nodeImageStatus('plain')).toBeNull();

    // The operator imports it; the next refresh opens the pool.
    missing.clear();
    await source.refresh();
    expect(source.poolSizes()).toEqual({ stack: 2, plain: 1 });
    expect(source.nodeImageStatus('stack')).toEqual({ missing: [], checked: true });
  });

  it('a probe that cannot answer leaves the assertion satisfied — weather never closes a gate', async () => {
    await store.create({ stampId: 'stack', config: { ...CHILD, nodeImages: ['gw:v12'] }, authorRef: 'g1' });
    await store.setPool('stack', 1);
    const source = new RegistryStampSource(store, () => {}, null, () => async () => {
      throw new Error('The connection to the server was refused');
    });
    await source.refresh();
    expect(source.poolSizes()).toEqual({ stack: 1 });
    // UNCHECKED, not present: an assertion nobody could answer must never
    // render as one that was answered.
    expect(source.nodeImageStatus('stack')).toEqual({ missing: [], checked: false });
  });

  it('a driver that declines the probe leaves the assertion ungated, never refused forever', async () => {
    await store.create({ stampId: 'stack', config: { ...CHILD, nodeImages: ['gw:v12'] }, authorRef: 'g1' });
    await store.setPool('stack', 1);
    const source = new RegistryStampSource(store); // no probe wired
    await source.refresh();
    expect(source.poolSizes()).toEqual({ stack: 1 });
    expect(source.nodeImageStatus('stack')).toEqual({ missing: [], checked: false });
  });
});

/**
 * The BOOT snapshot, through the real host-start hook.
 *
 * The probe is a thunk over a binding the hook assigns, so the order of two
 * lines decides whether the gate exists on the first pass at all: a refresh
 * taken before the driver was bound answers every nodeImages assertion
 * "unchecked", and the pool spends its first cycle filling a stamp whose
 * images are not on the node. Cheap to get wrong again, so it is pinned from
 * the outside — the hook, a real DB, a driver that answers.
 */
describe('the boot snapshot', () => {
  const asked: string[][] = [];
  let missing: string[] = [];

  registerDevEnvDriver('boot-probe-suite', () => ({
    kind: 'boot-probe-suite',
    capabilities: () => ({ isolation: 'test', sealedEgress: false, imagePull: false, imageBuild: false }),
    claim: () => Promise.reject(new Error('not used')),
    listInstances: () => Promise.resolve([]),
    missingNodeImages: (refs) => {
      asked.push(refs);
      return Promise.resolve(refs.filter((ref) => missing.includes(ref)));
    },
  }));

  afterEach(async () => {
    await stopHostModules();
    delete process.env.NANOCLAW_DEV_ENV_DRIVER;
    asked.length = 0;
  });

  it('is taken with the driver bound — the node-image gate is live from the first pass, not the second', async () => {
    await store.create({ stampId: 'stack', config: { ...CHILD, nodeImages: ['gw:v12'] }, authorRef: 'g1' });
    await store.setPool('stack', 1);
    missing = ['gw:v12'];
    process.env.NANOCLAW_DEV_ENV_DRIVER = 'boot-probe-suite';

    const controller = new AbortController();
    await startHostModules({ db, signal: controller.signal });
    controller.abort();

    const booted = getStampRegistry()!.source;
    expect(asked).toEqual([['gw:v12']]); // the boot refresh asked, which it could not do unbound
    expect(booted.nodeImageStatus('stack')).toEqual({ missing: ['gw:v12'], checked: true });
    expect(booted.poolSizes()).toEqual({}); // and the first pool pass is already gated
  });
});
