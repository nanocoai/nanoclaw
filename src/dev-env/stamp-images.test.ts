/**
 * The C15 image-origin vocabulary and the placement ledger.
 *
 * Two halves. The validation matrix pins the create-time refusals — the
 * mutually-exclusive shapes, the squatter clamp, the digest pin, the honest
 * build refusal — because every one of them is a promise the approver reads
 * a stamp under. The store half pins the state machine: pending→placing→
 * placed/failed, the adoption sweep with NO age gate, the eviction flip, and
 * digest-change visibility (a re-place that landed different bits is loud,
 * never absorbed).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import type { DbDriver } from '../db/driver.js';
import { runMigrations } from '../db/migrations/index.js';

// Side-effect: registers the dev-env migrations (stamp_images rides them).
import './index.js';
import { StampImageStore, imageGateRefusal, placeRef } from './stamp-images.js';
import { StampRegistryStore } from './stamp-registry.js';
import { fullyQualifiedImageRef, imageRefDigest, validateStampEntry, type K8sStampConfig } from './stamps.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const PULL: K8sStampConfig = { app: { image: `ghcr.example.invalid/org/app:1@${DIGEST}`, port: 8080 } };

describe('image-origin validation (C15)', () => {
  it('a fully-qualified, digest-pinned app image is the pull origin and validates', () => {
    expect(() => validateStampEntry('my-app', PULL)).not.toThrow();
  });

  it('refuses an unqualified ref — the squatter clamp — and offers the node-local opt-out', () => {
    expect(() => validateStampEntry('my-app', { app: { image: 'org/app:1', port: 80 } })).toThrow(
      /fully qualified.*node-local/s,
    );
    // No slash at all is the same lie in fewer characters.
    expect(() => validateStampEntry('my-app', { app: { image: 'app:dev', port: 80 } })).toThrow(/fully qualified/);
  });

  it('refuses an unpinned stored pull ref — a tag is not a pin — unless the caller is pre-resolution', () => {
    const tagged: K8sStampConfig = { app: { image: 'ghcr.example.invalid/org/app:1', port: 80 } };
    expect(() => validateStampEntry('my-app', tagged)).toThrow(/digest-pinned/);
    expect(() => validateStampEntry('my-app', tagged, { allowUnpinned: true })).not.toThrow();
  });

  it('node-local is the explicit opt-out: any ref shape, no credential allowed', () => {
    expect(() =>
      validateStampEntry('my-app', { app: { image: 'whoami:local', presence: 'node-local', port: 80 } }),
    ).not.toThrow();
    expect(() =>
      validateStampEntry('my-app', {
        app: { image: 'whoami:local', presence: 'node-local', imageCredential: 'ECR', port: 80 },
      }),
    ).toThrow(/never pulls/);
  });

  it('a code-provided table cannot carry a pull origin — nothing ever places for it', () => {
    expect(() => validateStampEntry('my-app', PULL, { codeProvided: true })).toThrow(/code-provided/);
    expect(() =>
      validateStampEntry(
        'my-app',
        { app: { image: 'mirror.gcr.io/library/alpine:3.20', presence: 'node-local', port: 80 } },
        { codeProvided: true },
      ),
    ).not.toThrow();
  });

  it('refuses the both-and (registry image + build block) with the field names, ahead of the build refusal', () => {
    expect(() =>
      validateStampEntry('my-app', { ...PULL, build: { dockerfile: 'Dockerfile' } }),
    ).toThrow(/mutually exclusive/);
  });

  it('refuses build-origin stamps with the not-yet-realized message — after the grammar earns its own refusals', () => {
    expect(() =>
      validateStampEntry('my-app', {
        app: { image: 'x:1', presence: 'node-local', port: 80 },
        build: { dockerfile: 'Dockerfile' },
      }),
    ).toThrow(/not yet realized/);
    expect(() =>
      validateStampEntry('my-app', { build: { dockerfile: '../escape/Dockerfile' } }),
    ).toThrow(/repo-relative/);
    expect(() => validateStampEntry('my-app', { build: { args: { 'bad key': 'v' } } })).toThrow(/argv-safe/);
  });

  it('refuses a pull origin on a childManifests stamp — out of scope in v1, said so', () => {
    expect(() =>
      validateStampEntry('my-app', {
        childManifests: '{}',
        readiness: { deployment: 'd', namespace: 'default' },
        app: { image: `x.example/app:1@${DIGEST}`, port: 80 },
      }),
    ).toThrow(/childManifests stamps take no registry-origin image/);
  });

  it('ref helpers: qualification heuristic and digest extraction', () => {
    expect(fullyQualifiedImageRef('ghcr.io/org/app:1')).toBe(true);
    expect(fullyQualifiedImageRef('localhost/app')).toBe(true);
    expect(fullyQualifiedImageRef('registry:5000/app')).toBe(true);
    expect(fullyQualifiedImageRef('org/app')).toBe(false);
    expect(fullyQualifiedImageRef('app:dev')).toBe(false);
    expect(imageRefDigest(`x.example/a@${DIGEST}`)).toBe(DIGEST);
    expect(imageRefDigest('x.example/a:1')).toBeNull();
  });
});

describe('the placement ledger', () => {
  let db: DbDriver;
  let images: StampImageStore;
  let registry: StampRegistryStore;

  beforeEach(async () => {
    db = await initTestDb();
    await runMigrations(db);
    images = new StampImageStore(db);
    registry = new StampRegistryStore(db);
  });

  afterEach(async () => {
    await closeDb();
  });

  async function pendingRow(stampId = 'my-app', version = 1) {
    return images.insertPending({
      stampId,
      version,
      origin: 'pull',
      ref: placeRef(stampId, version),
      sourceRef: `ghcr.example.invalid/org/app:1@${DIGEST}`,
    });
  }

  it('walks pending → placing → placed, recording started/placed and clearing errors', async () => {
    const row = await pendingRow();
    expect(row).toMatchObject({ state: 'pending', ref: 'place.nanoclaw.invalid/stamp/my-app:v1' });
    expect(await images.markPlacing('my-app', 1)).toBe(true);
    expect(await images.markPlacing('my-app', 1)).toBe(false); // not pending anymore — a racer loses
    const placed = await images.markPlaced('my-app', 1, DIGEST);
    expect(placed).toMatchObject({ state: 'placed', digest: DIGEST, priorDigest: null });
    expect(placed.placedAt).not.toBeNull();
  });

  it('failed carries its reason in the same write, and the gate text names state + start (#20, the brief shape)', async () => {
    await pendingRow();
    await images.markPlacing('my-app', 1);
    const failed = await images.markFailed('my-app', 1, '401 Unauthorized from the registry');
    expect(failed.error).toBe('401 Unauthorized from the registry');
    expect(imageGateRefusal(failed)).toMatch(
      /image for 'my-app' v1 is failed \(started .*\).*claimable when stamps get shows placed.*401 Unauthorized/s,
    );
    expect(imageGateRefusal(await images.get('my-app', 1).then((r) => r!))).toContain('stamps place my-app');
  });

  it('adoption fails ALL placing rows — no age gate, even a just-started one', async () => {
    await pendingRow('one', 1);
    await pendingRow('two', 1);
    await images.markPlacing('one', 1); // "just started" — inside any age gate that could exist
    const swept = await images.failAllPlacing('host restarted mid-placement');
    expect(swept.map((r) => r.stampId)).toEqual(['one']);
    expect((await images.get('one', 1))?.state).toBe('failed');
    expect((await images.get('two', 1))?.state).toBe('pending'); // pending rows are the queue, not corpses
  });

  it('the eviction flip returns to pending but KEEPS the recorded digest as provenance', async () => {
    await pendingRow();
    await images.markPlacing('my-app', 1);
    await images.markPlaced('my-app', 1, DIGEST);
    const reset = await images.resetToPending('my-app', 1, 'evicted from the driver store');
    expect(reset).toMatchObject({ state: 'pending', digest: DIGEST, error: 'evicted from the driver store' });
  });

  it('a re-place that lands a different digest is surfaced loudly, never absorbed', async () => {
    await pendingRow();
    await images.markPlacing('my-app', 1);
    await images.markPlaced('my-app', 1, DIGEST);
    await images.resetToPending('my-app', 1);
    await images.markPlacing('my-app', 1);
    const diverged = await images.markPlaced('my-app', 1, DIGEST_B);
    expect(diverged).toMatchObject({ digest: DIGEST_B, priorDigest: DIGEST });
    expect(diverged.digestChangedAt).not.toBeNull();
    // …and a same-digest re-place stays quiet: nothing diverged.
    await images.resetToPending('my-app', 1);
    await images.markPlacing('my-app', 1);
    const same = await images.markPlaced('my-app', 1, DIGEST_B);
    expect(same.priorDigest).toBe(DIGEST); // history kept, no new divergence stamped
  });

  it('rows are per-version and kept forever; the queue serves only CURRENT versions of active stamps', async () => {
    await registry.create({
      stampId: 'my-app',
      config: { app: { image: `ghcr.example.invalid/org/app:1@${DIGEST}`, port: 80 } },
      authorRef: 'g1',
    });
    await pendingRow('my-app', 1);
    await registry.update('my-app', { app: { image: `ghcr.example.invalid/org/app:2@${DIGEST_B}`, port: 80 } });
    await pendingRow('my-app', 2);

    // v1 is superseded: only v2 is the queue's business now.
    expect((await images.oldestCurrentPending())?.version).toBe(2);
    expect((await images.listForStamp('my-app')).map((r) => r.version)).toEqual([1, 2]);

    await images.markPlacing('my-app', 2);
    await images.markPlaced('my-app', 2, DIGEST_B);
    expect((await images.currentPlaced()).map((r) => [r.stampId, r.version])).toEqual([['my-app', 2]]);

    await registry.retire('my-app');
    expect(await images.oldestCurrentPending()).toBeUndefined();
    expect(await images.currentPlaced()).toEqual([]);
  });
});
