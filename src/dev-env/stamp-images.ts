/**
 * Stamp image provenance (C15) — the per-version placement ledger.
 *
 * One row per (stamp_id, version), inserted `pending` by the approved
 * create/update handler itself: row existence IS the approval, and
 * pre-approval nothing exists for a placement or a claim to find. The state
 * machine is `pending → placing → placed | failed`, plus two transitions the
 * reconciler alone performs: `placed → pending` when a re-probe finds the
 * store evicted the image (the claim gate closes honestly — the image
 * genuinely is not there), and `placing → failed` at adoption after a host
 * death (the reconciler is single and call-and-await, so NO in-flight
 * placement survives one — an age gate here would be a lease pattern for
 * work no peer can hold, and a `placing` row it excused would be re-examined
 * by nothing ever).
 *
 * Rows are kept FOREVER, prior versions included: a live env claimed at v(n)
 * chains env → stamp@version → digest → registry ref no matter how many
 * updates follow. `source_ref` is the origin's signed identity snapshotted at
 * insert — the registry's mutable `source` is overwritten on update, and the
 * digest→origin link must survive one.
 *
 * The `builds`/`mark-*` verbs of an earlier design do not exist ON PURPOSE:
 * the reconciler writes this table in-process, so "an agent that could
 * mark-placed could forge the state the claim gate trusts" is answered by
 * the verb not existing — stronger than host-caller-only.
 */
import type { DbDriver } from '../db/driver.js';
import type { ModuleMigration } from '../db/migrations/index.js';

export const stampImagesMigration: ModuleMigration = {
  version: 6,
  name: 'module:dev-env:stamp-images',
  // BIGINT, never INTEGER — see the house rules on `db.ts`'s header.
  async up(db: DbDriver) {
    await db.exec(`
      CREATE TABLE stamp_images (
        stamp_id            TEXT NOT NULL,
        version             BIGINT NOT NULL,
        origin              TEXT NOT NULL CHECK (origin IN ('pull','build')),
        state               TEXT NOT NULL CHECK (state IN ('pending','placing','placed','failed')),
        ref                 TEXT NOT NULL,
        source_ref          TEXT NOT NULL,
        digest              TEXT,
        prior_digest        TEXT,
        digest_changed_at   TEXT,
        error               TEXT,
        claimant_session_id TEXT,
        created_at          TEXT NOT NULL,
        started_at          TEXT,
        placed_at           TEXT,
        PRIMARY KEY (stamp_id, version)
      );
    `);
  },
};

export type StampImageState = 'pending' | 'placing' | 'placed' | 'failed';
export type StampImageOriginKind = 'pull' | 'build';

export interface StampImageRow {
  stampId: string;
  version: number;
  origin: StampImageOriginKind;
  state: StampImageState;
  /** The derived, NON-RESOLVABLE ref placement writes into the driver's store (see placeRef). */
  ref: string;
  /** What approval signed: `<registry-ref>@<digest>` for pulls (a build row would carry its sha). */
  sourceRef: string;
  /** What actually landed (the driver's storeId), recorded at placed. */
  digest: string | null;
  /** Digest-change visibility (the C1 lesson): a re-place that landed different bits, surfaced loudly. */
  priorDigest: string | null;
  digestChangedAt: string | null;
  error: string | null;
  /** The session the placement push tells when this row settles; null = nobody waits. */
  claimantSessionId: string | null;
  createdAt: string;
  startedAt: string | null;
  placedAt: string | null;
}

interface RawStampImageRow {
  stamp_id: string;
  version: number;
  origin: StampImageOriginKind;
  state: StampImageState;
  ref: string;
  source_ref: string;
  digest: string | null;
  prior_digest: string | null;
  digest_changed_at: string | null;
  error: string | null;
  claimant_session_id: string | null;
  created_at: string;
  started_at: string | null;
  placed_at: string | null;
}

function toRow(raw: RawStampImageRow): StampImageRow {
  return {
    stampId: raw.stamp_id,
    version: raw.version,
    origin: raw.origin,
    state: raw.state,
    ref: raw.ref,
    sourceRef: raw.source_ref,
    digest: raw.digest,
    priorDigest: raw.prior_digest,
    digestChangedAt: raw.digest_changed_at,
    error: raw.error,
    claimantSessionId: raw.claimant_session_id,
    createdAt: raw.created_at,
    startedAt: raw.started_at,
    placedAt: raw.placed_at,
  };
}

/**
 * The derived ref placement writes into the driver's store — REGISTRY-DERIVED
 * and never author-chosen (an author-named output could collide with or
 * shadow a trusted image in the store). `.invalid` is RFC-2606-reserved: no
 * resolver ever answers for it, which is what keeps "a claim never pulls"
 * MECHANICAL rather than policy — an evicted image under this ref is an
 * image-pull refusal the re-probe heals, never a live fetch at boot.
 */
export const PLACE_REF_HOST = 'place.nanoclaw.invalid';

export function placeRef(stampId: string, version: number): string {
  return `${PLACE_REF_HOST}/stamp/${stampId}:v${version}`;
}

export class StampImageStore {
  constructor(private db: DbDriver) {}

  async insertPending(row: {
    stampId: string;
    version: number;
    origin: StampImageOriginKind;
    ref: string;
    sourceRef: string;
    claimantSessionId?: string | null;
  }): Promise<StampImageRow> {
    await this.db.run(
      `INSERT INTO stamp_images (stamp_id, version, origin, state, ref, source_ref, claimant_session_id, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
      row.stampId,
      row.version,
      row.origin,
      row.ref,
      row.sourceRef,
      row.claimantSessionId ?? null,
      new Date().toISOString(),
    );
    return (await this.get(row.stampId, row.version))!;
  }

  async get(stampId: string, version: number): Promise<StampImageRow | undefined> {
    const raw = await this.db.get<RawStampImageRow>(
      'SELECT * FROM stamp_images WHERE stamp_id = ? AND version = ?',
      stampId,
      version,
    );
    return raw ? toRow(raw) : undefined;
  }

  async listForStamp(stampId: string): Promise<StampImageRow[]> {
    const raws = await this.db.all<RawStampImageRow>(
      'SELECT * FROM stamp_images WHERE stamp_id = ? ORDER BY version',
      stampId,
    );
    return raws.map(toRow);
  }

  /**
   * The reconciler's queue head: the oldest `pending` row whose version is
   * its stamp's CURRENT one on an active registration. Superseded versions
   * never place (an updated stamp is honestly unclaimable until its NEW
   * image places — placing the old one would spend the queue on a definition
   * no claim can resolve), and retired stamps have nothing left to open.
   */
  async oldestCurrentPending(): Promise<StampImageRow | undefined> {
    const raw = await this.db.get<RawStampImageRow>(
      `SELECT s.* FROM stamp_images s
       JOIN stamp_registry r ON r.stamp_id = s.stamp_id AND r.version = s.version AND r.state = 'active'
       WHERE s.state = 'pending' ORDER BY s.created_at LIMIT 1`,
    );
    return raw ? toRow(raw) : undefined;
  }

  /** Current-version `placed` rows on active registrations — the re-probe's worklist. */
  async currentPlaced(): Promise<StampImageRow[]> {
    const raws = await this.db.all<RawStampImageRow>(
      `SELECT s.* FROM stamp_images s
       JOIN stamp_registry r ON r.stamp_id = s.stamp_id AND r.version = s.version AND r.state = 'active'
       WHERE s.state = 'placed' ORDER BY s.stamp_id`,
    );
    return raws.map(toRow);
  }

  /** pending → placing, recording started_at. Returns false when the row was not pending (a racer won). */
  async markPlacing(stampId: string, version: number, startedAt = new Date().toISOString()): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE stamp_images SET state = 'placing', started_at = ?, error = NULL
       WHERE stamp_id = ? AND version = ? AND state = 'pending'`,
      startedAt,
      stampId,
      version,
    );
    return result.changes > 0;
  }

  /**
   * placing → placed. A digest that differs from the version's previously
   * recorded one is kept LOUDLY (prior_digest + when) — never absorbed. On
   * the pull path the case is dead by construction (a re-pull of a signed
   * digest is bit-identical or it fails), but the mechanism must exist before
   * the origin that needs it does.
   */
  async markPlaced(stampId: string, version: number, digest: string): Promise<StampImageRow> {
    const existing = await this.get(stampId, version);
    const diverged = existing?.digest != null && existing.digest !== digest;
    await this.db.run(
      `UPDATE stamp_images SET state = 'placed', digest = ?, prior_digest = ?, digest_changed_at = ?,
         placed_at = ?, error = NULL
       WHERE stamp_id = ? AND version = ?`,
      digest,
      diverged ? existing!.digest : (existing?.priorDigest ?? null),
      diverged ? new Date().toISOString() : (existing?.digestChangedAt ?? null),
      new Date().toISOString(),
      stampId,
      version,
    );
    return (await this.get(stampId, version))!;
  }

  /** → failed, reason and state in ONE write (#20: a failure without a recorded reason is a support ticket). */
  async markFailed(stampId: string, version: number, error: string): Promise<StampImageRow> {
    await this.db.run(
      `UPDATE stamp_images SET state = 'failed', error = ? WHERE stamp_id = ? AND version = ?`,
      error,
      stampId,
      version,
    );
    return (await this.get(stampId, version))!;
  }

  /**
   * Back to `pending` — the re-place (`stamps place`) and the re-probe's
   * eviction flip. The recorded digest STAYS as provenance: it is what the
   * next placed compares against for divergence visibility.
   */
  async resetToPending(stampId: string, version: number, reason: string | null = null): Promise<StampImageRow> {
    await this.db.run(
      `UPDATE stamp_images SET state = 'pending', error = ?, started_at = NULL, placed_at = NULL
       WHERE stamp_id = ? AND version = ?`,
      reason,
      stampId,
      version,
    );
    return (await this.get(stampId, version))!;
  }

  /**
   * Adoption's boot sweep: ALL `placing` rows → failed, no age gate (module
   * header says why a gate would be the exact eternal-state class this
   * exists to kill). Re-running is safe — a pull is probe-idempotent.
   */
  async failAllPlacing(reason: string): Promise<StampImageRow[]> {
    const raws = await this.db.all<RawStampImageRow>(`SELECT * FROM stamp_images WHERE state = 'placing'`);
    const failed: StampImageRow[] = [];
    for (const raw of raws) failed.push(await this.markFailed(raw.stamp_id, raw.version, reason));
    return failed;
  }
}

/**
 * The claim gate's refusal text — ONE composer so the service's refusal and
 * anything that quotes it cannot drift. Null = the gate is open (placed).
 * The shape is the brief's: state + when it started, never a boot timeout.
 */
export function imageGateRefusal(row: StampImageRow): string | null {
  if (row.state === 'placed') return null;
  const since = row.startedAt ?? row.createdAt;
  const base = `image for '${row.stampId}' v${row.version} is ${row.state} (started ${since}) — claimable when stamps get shows placed`;
  if (row.state === 'failed') {
    return `${base}; ${row.error ?? 'no reason recorded'} (ncl stamps place ${row.stampId} re-runs the approved pull)`;
  }
  return base;
}

/**
 * The refusal for an approved registry-origin stamp with NO row at all — a
 * registration that predates the image path (or a crash between the row and
 * its ledger entry). Honest and directive rather than a fake `pending`: no
 * approval ever signed a digest for this version.
 */
export function imageGateNoRecord(stampId: string, version: number): string {
  return (
    `stamp '${stampId}' v${version} declares a registry image but has no placement record — it predates the image ` +
    `path (or its record was lost); ncl stamps place ${stampId} queues the recorded ref, or re-approve via stamps update`
  );
}
