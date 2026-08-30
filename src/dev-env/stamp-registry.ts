/**
 * The stamps registry (C12) — stamps as a runtime resource.
 *
 * Before this module, a deployment's stamp table was boot-time configuration:
 * the builtin table plus whatever NANOCLAW_DEV_ENV_K8S_STAMPS replaced it
 * with, frozen at driver construction, pools frozen beside it. The registry
 * makes stamps ROWS: an agent authors a manifest for the project it is
 * working on, `ncl stamps create` registers it (approval-gated — the
 * registration IS the approval moment), and the approved row is claimable
 * like any builtin. Pool sizes ride the rows too, so `set-pool` takes effect
 * within one reconcile interval instead of a restart.
 *
 * Two deliberate boundaries:
 * - CODE-PROVIDED STAMPS WIN. The builtin table (and any env-configured
 *   replacement) stays code/config-provided and shadows same-id registry
 *   rows — a baked child manifest must update with the code that renders it,
 *   never drift behind a frozen row copy. `create` refuses builtin ids.
 * - VALIDATION AT THE WRITE. Every structural refusal the driver's
 *   constructor performs runs at create/update (stamps.ts
 *   validateStampEntry), in front of the approving human — and again
 *   defensively at claim, because a row may predate a validation rule.
 *
 * The driver's probe paths are synchronous while the store is async, so the
 * driver never reads the store directly: `RegistryStampSource` holds a
 * SNAPSHOT refreshed on the async edges (claim, pool reconcile, CLI
 * mutation) and answers sync reads from it. Staleness is bounded by the
 * reconcile interval and harmless — an instance realizes the definition its
 * claim resolved, which is exactly what the recorded stamp_version says.
 */
import type { DbDriver } from '../db/driver.js';
import type { ModuleMigration } from '../db/migrations/index.js';
import { log } from '../log.js';

import type { StampImageRow, StampImageStore } from './stamp-images.js';
import { stampImageOrigin, validateStampEntry, type K8sStampConfig } from './stamps.js';

export const stampRegistryMigration: ModuleMigration = {
  version: 3,
  name: 'module:dev-env:stamp-registry',
  // BIGINT, never INTEGER — see the house rules on `db.ts`'s header.
  async up(db: DbDriver) {
    await db.exec(`
      CREATE TABLE stamp_registry (
        stamp_id   TEXT PRIMARY KEY,
        config     TEXT NOT NULL,
        pool_size  BIGINT NOT NULL DEFAULT 0,
        version    BIGINT NOT NULL DEFAULT 1,
        state      TEXT NOT NULL CHECK (state IN ('active','retired')),
        author_ref TEXT NOT NULL,
        source     TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    // Which approved definition realized a claim (null = a code-provided
    // stamp). Rides dev_envs because provenance is the HOST's ledger — the
    // driver seam never learns registry concepts.
    await db.exec(`ALTER TABLE dev_envs ADD COLUMN stamp_version BIGINT`);
  },
};

export type StampState = 'active' | 'retired';

export interface StampRow {
  stampId: string;
  config: K8sStampConfig;
  poolSize: number;
  version: number;
  state: StampState;
  authorRef: string;
  /** Freeform provenance the author supplied (repo, revision, path…). */
  source: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

interface RawStampRow {
  stamp_id: string;
  config: string;
  pool_size: number;
  version: number;
  state: StampState;
  author_ref: string;
  source: string | null;
  created_at: string;
  updated_at: string;
}

function toStampRow(raw: RawStampRow): StampRow {
  return {
    stampId: raw.stamp_id,
    config: JSON.parse(raw.config) as K8sStampConfig,
    poolSize: raw.pool_size,
    version: raw.version,
    state: raw.state,
    authorRef: raw.author_ref,
    source: raw.source ? (JSON.parse(raw.source) as Record<string, unknown>) : null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export class StampRegistryStore {
  constructor(
    private db: DbDriver,
    /** Ids the registry must refuse — the code-provided table's, which shadow rows. */
    private reservedIds: () => string[] = () => [],
  ) {}

  async create(row: {
    stampId: string;
    config: K8sStampConfig;
    authorRef: string;
    source?: Record<string, unknown>;
  }): Promise<StampRow> {
    validateStampEntry(row.stampId, row.config);
    if (this.reservedIds().includes(row.stampId)) {
      throw new Error(
        `stamp id '${row.stampId}' is code-provided on this deployment and cannot be registered over — pick another id`,
      );
    }
    if (await this.get(row.stampId)) {
      throw new Error(`stamp '${row.stampId}' already exists — use stamps update, or retire it first`);
    }
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO stamp_registry (stamp_id, config, pool_size, version, state, author_ref, source, created_at, updated_at)
       VALUES (?, ?, 0, 1, 'active', ?, ?, ?, ?)`,
      row.stampId,
      JSON.stringify(row.config),
      row.authorRef,
      row.source ? JSON.stringify(row.source) : null,
      now,
      now,
    );
    return (await this.get(row.stampId))!;
  }

  async get(stampId: string): Promise<StampRow | undefined> {
    const raw = await this.db.get<RawStampRow>('SELECT * FROM stamp_registry WHERE stamp_id = ?', stampId);
    return raw ? toStampRow(raw) : undefined;
  }

  async list(filter: { state?: StampState } = {}): Promise<StampRow[]> {
    const raws = filter.state
      ? await this.db.all<RawStampRow>('SELECT * FROM stamp_registry WHERE state = ? ORDER BY stamp_id', filter.state)
      : await this.db.all<RawStampRow>('SELECT * FROM stamp_registry ORDER BY stamp_id');
    return raws.map(toStampRow);
  }

  /** A new approved definition under the same id: version increments — claims record which one realized them. */
  async update(stampId: string, config: K8sStampConfig, source?: Record<string, unknown>): Promise<StampRow> {
    validateStampEntry(stampId, config);
    const existing = await this.mustGet(stampId);
    if (existing.state === 'retired') {
      throw new Error(`stamp '${stampId}' is retired — register a new id instead of updating a retired definition`);
    }
    await this.db.run(
      `UPDATE stamp_registry SET config = ?, version = version + 1, source = COALESCE(?, source), updated_at = ? WHERE stamp_id = ?`,
      JSON.stringify(config),
      source ? JSON.stringify(source) : null,
      new Date().toISOString(),
      stampId,
    );
    return (await this.get(stampId))!;
  }

  /**
   * Retire, never delete: live envs (and the provenance ledger) may still
   * reference the id. New claims refuse a retired stamp; existing instances
   * are untouched — the frozen-instance rule extends to their definitions.
   */
  async retire(stampId: string): Promise<StampRow> {
    await this.mustGet(stampId);
    await this.db.run(
      `UPDATE stamp_registry SET state = 'retired', pool_size = 0, updated_at = ? WHERE stamp_id = ?`,
      new Date().toISOString(),
      stampId,
    );
    return (await this.get(stampId))!;
  }

  async setPool(stampId: string, size: number): Promise<StampRow> {
    if (!Number.isInteger(size) || size < 0) throw new Error(`pool size must be a non-negative integer, got ${size}`);
    const existing = await this.mustGet(stampId);
    if (existing.state === 'retired' && size > 0) {
      throw new Error(`stamp '${stampId}' is retired — a retired stamp cannot hold a warm pool`);
    }
    await this.db.run(
      'UPDATE stamp_registry SET pool_size = ?, updated_at = ? WHERE stamp_id = ?',
      size,
      new Date().toISOString(),
      stampId,
    );
    return (await this.get(stampId))!;
  }

  private async mustGet(stampId: string): Promise<StampRow> {
    const row = await this.get(stampId);
    if (!row) throw new Error(`no stamp '${stampId}' in the registry`);
    return row;
  }
}

/**
 * The driver's sync window onto the async registry — see the module header.
 * `refresh()` runs on the async edges; the sync getters answer from the last
 * snapshot. Rows are re-validated on load (defensively — a row may predate a
 * rule) and an invalid one is EXCLUDED loudly via `invalid()` rather than
 * crashing the refresh: one bad row must not take the claim path down.
 */
export interface StampSource {
  refresh(): Promise<void>;
  getStamp(stampId: string): K8sStampConfig | undefined;
  stampVersion(stampId: string): number | undefined;
  /**
   * Warm-slot targets for the rows that want one — an id with no pool is
   * OMITTED, not reported as zero. The driver's merge with its static config
   * therefore cannot read an omission as "off" and asks `getStamp` instead
   * (k8s-driver poolTargets); a registry row owns its id's pool either way.
   */
  poolSizes(): Record<string, number>;
  /**
   * Whether the id names a RETIRED registration. Optional and advisory; the
   * one consumer is the claim refusal, which owes the agent "retired" rather
   * than "no such stamp" — the id resolved minutes ago, and the difference is
   * what says re-registration (not a typo hunt) is the way forward (#21).
   */
  retiredStamp?(stampId: string): boolean;
  /**
   * The current version's PLACED image, when the stamp's origin is the
   * registry pull path (C15): what a driver renders for it — the derived
   * ref pinned to this digest — and null while unplaced (the claim gate
   * above the seam refuses those; a driver seeing null anyway records a
   * deterministic rejection rather than booting a pod that can never pull).
   */
  placedImage?(stampId: string): { digest: string; version: number } | null;
}

/**
 * The pool as the driver OBSERVES it for one stamp: slots claimable right
 * now, slots booting toward warm, slots on their way out (the namespace is
 * terminating, or it is past the pool's budget and the next reconcile reaps
 * it), and the corpses of fills that DIED. Counts, never identities.
 *
 * Three live states and one history. `failed` is the news a count of live
 * capacity hides best — a pool whose every fill dies holds `warm 0` forever,
 * pixel-identical to one that simply has not filled yet, and the difference is
 * minutes of waiting versus a broken stamp. But nothing reaps a pool corpse,
 * so that count is RESIDUE: cumulative for the life of the pool, never
 * cleared, and a live-looking number that only grows would leave a recovered
 * pool advertising failure forever. `lastFailureAgeMs` is what keeps it
 * honest — the same two corpses read as a broken stamp at `3m` and as history
 * at `3h` beside a warm slot — and readers render the pair as history, apart
 * from the live counts.
 */
export interface PoolObservation {
  warm: number;
  filling: number;
  draining: number;
  /** Corpses left behind by dead fills. Residue, not live state — see above. */
  failed: number;
  /**
   * How long ago the most recent of those corpses died, measured where the
   * count was taken (the driver owns the clock). Absent when there are none —
   * or when the corpses carry no timestamp, which counts but cannot be dated.
   */
  lastFailureAgeMs?: number;
}

/**
 * The mirror of `StampSource.poolSizes()` — sizes travel DOWN to the driver,
 * the observation comes back UP. Declared here, beside the desired half, and
 * deliberately NOT on the driver seam: pooling stays driver-private (D5 —
 * `types.ts` names no pool, because "seconds to claim" is one driver's
 * strategy and never a promise of the contract). A driver that pools nothing
 * simply is not a `PoolObserver`, and its readers render the desired size
 * alone rather than zeros nobody measured.
 *
 * One question — "what are you holding right now?" — answered for every stamp
 * at once, so a `stamps list` costs one runtime query instead of one per row.
 * The answer is counts keyed by STAMP: no env, owner, or instance identity
 * crosses, which is what lets an agent-scoped read render it whole.
 */
export interface PoolObserver {
  observePools(): Record<string, PoolObservation>;
}

/**
 * What a reader gets back when it asks for the observed half — three answers,
 * because two of them used to be one and that collapse was itself an
 * ambiguity this change exists to kill:
 * - `observed`: counted, and the counts are the answer.
 * - `unpooled`: no driver registered, or one that pools nothing. There is no
 *   number to render; the desired size stands alone, exactly as it did before
 *   the observed half existed.
 * - `unreadable`: there IS a pool and the count did not come back. A read that
 *   renders that as `unpooled` tells an author "nothing to see" about a
 *   runtime nobody could reach — the one lie a pool observation must not tell.
 *
 * The failure DETAIL stays in the host log, not on the row: it is a kubectl
 * error carrying apiserver addresses, and this line is read by agents.
 */
export type PoolReading =
  | { state: 'observed'; pools: Record<string, PoolObservation> }
  | { state: 'unpooled' }
  | { state: 'unreadable' };

/**
 * The join between the two halves, in ONE place: narrow, count, and degrade.
 * Both sides of it — the driver that counts and the reader that renders — are
 * otherwise tested against a stub of the other, so this is the seam a
 * shape-drift would slip through, and it is small enough to test whole.
 *
 * Counting the pool is what a stamp read ADDS; it must never be what makes one
 * fail. So a throwing observation degrades to a rendered `unreadable`, never
 * to an error frame.
 */
export function readPools(driver: unknown): PoolReading {
  const observer = driver as PoolObserver | null;
  if (typeof observer?.observePools !== 'function') return { state: 'unpooled' };
  try {
    return { state: 'observed', pools: observer.observePools() };
  } catch (error) {
    log.warn('Dev-env: pool observation failed', { error: String(error) });
    return { state: 'unreadable' };
  }
}

interface SnapshotEntry {
  config: K8sStampConfig;
  version: number;
  poolSize: number;
  /** The current version's placement row, for pull-origin stamps with one. */
  image: StampImageRow | null;
  /** What the last refresh could say about the row's declared `nodeImages`. */
  nodeImages: NodeImageStatus;
}

/**
 * The node-image gate's STATE, per stamp — the thing `ncl stamps list` renders
 * beside the placement state, and the reason this gate is not the first claim
 * gate an operator cannot see.
 *
 * `checked: false` is its own answer and must never render as "present": it
 * means no driver answers the probe, or the probe threw this cycle, so the
 * assertion gated nothing (declared in SKILL.md). Only `checked: true` with a
 * non-empty `missing` closes the pool.
 */
export interface NodeImageStatus {
  /** Declared refs the node's store did not hold. Always empty while unchecked. */
  missing: string[];
  /** Did a probe answer this refresh at all? */
  checked: boolean;
}

/** The status of a row that declares no node images — nothing to check, nothing to show. */
const NO_NODE_IMAGES: NodeImageStatus = { missing: [], checked: true };

/**
 * How the source asks what the node's image store holds — the driver's bulk
 * probe, injected as a THUNK because the driver is constructed after the
 * source (the same reason `driverCapabilities` is one). Null = this deployment
 * cannot answer the question at all, and a `nodeImages` assertion then gates
 * nothing: refusing every such stamp forever would be a worse lie than the
 * unanswered assertion, and the declaration still tells an operator what to
 * import. Declared in SKILL.md.
 */
export type NodeImageProbe = (refs: string[]) => Promise<string[]>;

export class RegistryStampSource implements StampSource {
  private snapshot = new Map<string, SnapshotEntry>();
  private invalidRows: string[] = [];
  private retiredIds = new Set<string>();

  constructor(
    private store: StampRegistryStore,
    private onInvalid: (stampId: string, error: string) => void = () => {},
    /** The C15 placement ledger; absent = no pull-origin stamps exist to gate. */
    private images: StampImageStore | null = null,
    /** The node-presence probe (C15's node-local half); see NodeImageProbe. */
    private nodeImageProbe: () => NodeImageProbe | null = () => null,
  ) {}

  async refresh(): Promise<void> {
    const rows = await this.store.list();
    const next = new Map<string, SnapshotEntry>();
    const invalid: string[] = [];
    const retired = new Set<string>();
    for (const row of rows) {
      if (row.state === 'retired') {
        // Never enters the table — remembered only so the claim refusal can
        // say 'retired' instead of 'no such stamp' (#21).
        retired.add(row.stampId);
        continue;
      }
      try {
        validateStampEntry(row.stampId, row.config);
        // The placement row rides the snapshot (C15): the pool reconciler and
        // the driver's render read it sync, bounded by the same staleness the
        // whole snapshot already accepts.
        const image =
          this.images && stampImageOrigin(row.config).kind === 'pull'
            ? ((await this.images.get(row.stampId, row.version)) ?? null)
            : null;
        next.set(row.stampId, {
          config: row.config,
          version: row.version,
          poolSize: row.poolSize,
          image,
          nodeImages: NO_NODE_IMAGES,
        });
      } catch (error) {
        invalid.push(row.stampId);
        this.onInvalid(row.stampId, String(error));
      }
    }
    await this.resolveNodePresence(next);
    this.snapshot = next;
    this.invalidRows = invalid;
    this.retiredIds = retired;
  }

  /**
   * One node read for every declared image in the table, split back per stamp.
   * Probe WEATHER never closes a gate (the placement re-probe's rule): an
   * unreachable node leaves every assertion satisfied for this cycle, marked
   * UNCHECKED so nothing renders it as presence, and the next refresh — sixty
   * seconds away — asks again.
   *
   * This gate is recomputed from scratch every pass and closing it costs warm
   * slots (`poolSizes` omits the stamp and the driver's reap drains what it
   * had), so every EDGE is logged: an operator must be able to find the moment
   * a pool stopped filling without reading a diff of two `stamps list` runs.
   */
  private async resolveNodePresence(next: Map<string, SnapshotEntry>): Promise<void> {
    const declared = [...next.values()].filter((entry) => (entry.config.nodeImages ?? []).length > 0);
    if (declared.length === 0) return;
    // No driver verb, or a probe that threw: UNCHECKED, which is the whole
    // difference between "checked and present" and "never asked".
    const missing = await this.probeNodeImages([...new Set(declared.flatMap((entry) => entry.config.nodeImages!))]);
    for (const entry of declared) {
      entry.nodeImages = missing
        ? { missing: entry.config.nodeImages!.filter((ref) => missing.has(ref)), checked: true }
        : { missing: [], checked: false };
    }
    this.logNodeImageEdges(next);
  }

  /** The refs the node's store lacks, or null when nothing could answer this cycle. */
  private async probeNodeImages(refs: string[]): Promise<Set<string> | null> {
    const probe = this.nodeImageProbe();
    if (!probe) return null;
    try {
      return new Set(await probe(refs));
    } catch (error) {
      log.warn('Dev-env: node-image probe failed; leaving every nodeImages assertion satisfied this cycle', {
        error: String(error),
      });
      return null;
    }
  }

  /** Log only the stamps whose node-image verdict CHANGED — the gate's edges, not its level. */
  private logNodeImageEdges(next: Map<string, SnapshotEntry>): void {
    for (const [id, entry] of next) {
      const before = this.snapshot.get(id)?.nodeImages ?? NO_NODE_IMAGES;
      const after = entry.nodeImages;
      if (before.checked === after.checked && before.missing.join(',') === after.missing.join(',')) continue;
      if (after.missing.length > 0) {
        log.warn('Dev-env: node-image gate CLOSED — the pool stops filling and claims are refused by name', {
          stamp: id,
          missing: after.missing,
          hint: 'import on the node (docker save | ctr images import), then ncl stamps list to confirm',
        });
      } else if (!after.checked) {
        log.info('Dev-env: node-image assertion is UNCHECKED this cycle — it gates nothing', { stamp: id });
      } else {
        log.info('Dev-env: node-image gate open — every declared image is in the node store', { stamp: id });
      }
    }
  }

  getStamp(stampId: string): K8sStampConfig | undefined {
    return this.snapshot.get(stampId)?.config;
  }

  stampVersion(stampId: string): number | undefined {
    return this.snapshot.get(stampId)?.version;
  }

  poolSizes(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, entry] of this.snapshot) {
      // Unplaced pull-origin stamps are OMITTED (C15): a pool fill for an
      // image that is not in the store would burn a boot budget per attempt
      // discovering what the ledger already says. A stamp missing a declared
      // NODE image is omitted for exactly the same reason — its pods would sit
      // in ImagePullBackOff, which the warm gate can only read as "not yet".
      if (entry.poolSize > 0 && this.gateOpen(entry)) out[id] = entry.poolSize;
    }
    return out;
  }

  placedImage(stampId: string): { digest: string; version: number } | null {
    const entry = this.snapshot.get(stampId);
    if (!entry?.image || entry.image.state !== 'placed' || !entry.image.digest) return null;
    return { digest: entry.image.digest, version: entry.image.version };
  }

  /** Open for non-pull origins; pull origins open exactly at `placed` (a missing row is closed — nothing signed it). */
  private gateOpen(entry: SnapshotEntry): boolean {
    if (entry.nodeImages.missing.length > 0) return false;
    if (stampImageOrigin(entry.config).kind !== 'pull') return true;
    return entry.image?.state === 'placed';
  }

  /**
   * The node-image gate's standing state for one stamp — what `ncl stamps list`
   * renders, and null when the row declares no node images (or is not in the
   * table at all: retired, excluded, or code-provided).
   */
  nodeImageStatus(stampId: string): NodeImageStatus | null {
    const entry = this.snapshot.get(stampId);
    if (!entry || (entry.config.nodeImages ?? []).length === 0) return null;
    return { missing: [...entry.nodeImages.missing], checked: entry.nodeImages.checked };
  }

  retiredStamp(stampId: string): boolean {
    return this.retiredIds.has(stampId);
  }

  /** Rows the last refresh excluded — surfaced by `stamps list`, never hidden. */
  invalid(): string[] {
    return [...this.invalidRows];
  }
}
