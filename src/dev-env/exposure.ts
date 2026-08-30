/**
 * Env exposures (C14) — the named-grant ledger.
 *
 * An EXPOSURE is three things and a transport is none of them: a stable NAME,
 * a TARGET (env + frozen service + port), and a PROVIDER that carries the
 * name to a browser. The grant, the approval, the audit row and revocation
 * bind to the name and the target — never to how the bytes travel. That is
 * what lets a future `dns` provider replace `tailnet` without touching one
 * granted row: `provider_detail` is the only column a provider writes, and
 * nothing in the grant model ever reads inside it.
 *
 * Rows are never deleted — this table IS the audit trail, and the tailnet
 * provider's least-recently-revoked port allocation reads its own detail out
 * of the ended rows, so a freed number idles as long as the range allows
 * before an old URL can mean a new env.
 *
 * Intent-first, the same ordering claims use: the row lands `pending` before
 * the provider is asked for anything, so a host that dies mid-realize leaves
 * a row adoption can judge — never a live serve entry no ledger names, and
 * never a URL shown live that does not serve.
 */
import type { DbDriver } from '../db/driver.js';
import type { ModuleMigration } from '../db/migrations/index.js';

/**
 * Why an exposure ended. The vocabulary is deliberately small and every value
 * is written by a code path that exists:
 * - `requested`  — `ncl envs unexpose`, the operator/agent closing their own hole.
 * - `released`   — the env ended (explicit release, TTL reap, bound-owner release,
 *                  adopt reconcile). An exposed port dies with its env, unasked.
 * - `env-failed` — the env's instance failed; a failed env has no reachability to keep.
 * - `stamp-retired` — the definition the approval named was withdrawn. The env keeps
 *                  running (retire leaves live envs untouched); only the hole closes.
 * - `realize-failed` — the provider could not bring the name live. The grant fails
 *                  loudly and the row records why, rather than advertising a dead URL.
 * - `promoted`   — reserved for C7: moving a name from `tailnet` to `dns` is a FRESH
 *                  grant on a revoked row (Gavriel's ruling on open question 5),
 *                  because the perimeter changes and the approval is against a
 *                  perimeter. No v1 path writes it; it is here so the promotion does
 *                  not invent a vocabulary the audit trail has never carried.
 */
export type ExposureRevokeCause =
  | 'requested'
  | 'released'
  | 'env-failed'
  | 'stamp-retired'
  | 'realize-failed'
  | 'promoted';

export const EXPOSURE_REVOKE_CAUSES: ExposureRevokeCause[] = [
  'requested',
  'released',
  'env-failed',
  'stamp-retired',
  'realize-failed',
  'promoted',
];

/** `pending` = granted, not yet carried; `live` = the URL serves; `revoked` = terminal. */
export type ExposureState = 'pending' | 'live' | 'revoked';

/**
 * The env-uniqueness index, DROPPED — as its own migration, because editing
 * version 7 in place drops it on nobody.
 *
 * `env-exposures` (version 7) originally created two partial unique indexes,
 * and removing the `env_id` one from that statement changes what a FRESH
 * database gets and nothing else. The runner selects pending migrations BY NAME
 * (`src/db/migrations/index.ts`), with no checksum — "Never rename a migration
 * after release" — so a box that already applied version 7 has it recorded as
 * done and never re-reads it. On the runc box, which has this module applied
 * and a live exposure today, `idx_env_exposures_live_env` would simply survive
 * and the second `ncl envs expose` would still die at the database.
 *
 * And it would die badly. `insertGrant` translates a constraint violation by
 * looking up the holder of the NAME; a second exposure carries a different
 * name, finds no holder, and rethrows the raw driver text — so the operator
 * gets `UNIQUE constraint failed: env_exposures.env_id` with no remedy and no
 * mention of the seam that refused them.
 *
 */
export const envExposuresDropEnvIndexMigration: ModuleMigration = {
  version: 8,
  name: 'module:dev-env:env-exposures-drop-env-index',
  async up(db: DbDriver) {
    // `IF EXISTS`, because a fresh database never created it — version 7 no
    // longer declares it, so this is a no-op there and the whole point of it is
    // the box that predates the change. Native in both dialects.
    await db.exec('DROP INDEX IF EXISTS idx_env_exposures_live_env;');
  },
};

export const envExposuresMigration: ModuleMigration = {
  version: 7,
  name: 'module:dev-env:env-exposures',
  // BIGINT, never INTEGER — see the house rules on `db.ts`'s header. `port`
  // never approaches int4's ceiling, but a single width rule is what keeps the
  // next author from having to decide, and it is what the PostgreSQL baseline
  // gives every SQLite INTEGER.
  //
  // ONE unique index, on the NAME, and its WHERE clause is load-bearing: the
  // partial index is what stops two approved replays landing two grants on one
  // name in the same tick, and dropping the WHERE turns "one LIVE grant per
  // name" into "one grant EVER", which makes a revoked name un-re-mintable.
  // Partial unique indexes are native PostgreSQL and need no rewrite — the
  // hazard here is a port that "tidies" the WHERE away, and no gate would
  // notice.
  //
  // There is deliberately NO uniqueness on `env_id`, and there was: an env
  // used to get one slot. An env is a whole live system, not a single page —
  // a claimed child has to answer as its chat UI AND as its governance
  // dashboard at the same time — and under the env index the second grant
  // died at the database, where the caller wanted a second name. Uniqueness
  // belongs on the name, which is already the ledger key, already the subject
  // of the approval, and already the future hostname; the env is a target,
  // and a target may be reached by more than one name.
  async up(db: DbDriver) {
    await db.exec(`
      CREATE TABLE env_exposures (
        exposure_id     TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        env_id          TEXT NOT NULL REFERENCES dev_envs(env_id),
        service         TEXT NOT NULL,
        port            BIGINT NOT NULL,
        provider        TEXT NOT NULL,
        provider_detail TEXT NOT NULL,
        url             TEXT NOT NULL,
        owner_ref       TEXT NOT NULL,
        approved_by     TEXT NOT NULL,
        state           TEXT NOT NULL CHECK (state IN ('pending','live','revoked')),
        claimant_session_id TEXT,
        created_at      TEXT NOT NULL,
        revoked_at      TEXT,
        revoke_cause    TEXT
      );
      -- The name is unique among LIVE-and-pending grants only: a revoked name is
      -- re-mintable in v1 (the ruling on open question 2), where the tailnet URL
      -- never carries the name anyway. A partial index rather than handler
      -- arithmetic, because two approved replays can land in the same tick.
      CREATE UNIQUE INDEX idx_env_exposures_live_name ON env_exposures(name)
        WHERE state IN ('pending','live');
    `);
  },
};

export interface ExposureRow {
  exposureId: string;
  /** The thing that outlives instances — and, at promotion, providers. */
  name: string;
  envId: string;
  /** The service as FROZEN at grant: resolved once, never re-guessed at dial time. */
  service: string;
  port: number;
  provider: string;
  /** Provider-internal, opaque to the grant model (the tailnet provider keeps its ext port here). */
  providerDetail: Record<string, string>;
  url: string;
  ownerRef: string;
  approvedBy: string;
  state: ExposureState;
  /** The session an unasked transition is pushed to (#223's transport); null = nobody waits. */
  claimantSessionId: string | null;
  createdAt: string;
  revokedAt: string | null;
  revokeCause: ExposureRevokeCause | null;
}

interface RawExposureRow {
  exposure_id: string;
  name: string;
  env_id: string;
  service: string;
  port: number;
  provider: string;
  provider_detail: string;
  url: string;
  owner_ref: string;
  approved_by: string;
  state: ExposureState;
  claimant_session_id: string | null;
  created_at: string;
  revoked_at: string | null;
  revoke_cause: ExposureRevokeCause | null;
}

function toRow(raw: RawExposureRow): ExposureRow {
  return {
    exposureId: raw.exposure_id,
    name: raw.name,
    envId: raw.env_id,
    service: raw.service,
    port: raw.port,
    provider: raw.provider,
    providerDetail: JSON.parse(raw.provider_detail) as Record<string, string>,
    url: raw.url,
    ownerRef: raw.owner_ref,
    approvedBy: raw.approved_by,
    state: raw.state,
    claimantSessionId: raw.claimant_session_id,
    createdAt: raw.created_at,
    revokedAt: raw.revoked_at,
    revokeCause: raw.revoke_cause,
  };
}

/** A grant row is live-or-pending: both hold the name, and both are the provider's to carry. */
export function exposureIsLive(row: ExposureRow): boolean {
  return row.state === 'pending' || row.state === 'live';
}

/**
 * DNS-label grammar, enforced NOW so every v1 name is already a valid future
 * hostname (the ruling on open question 2). Under the tailnet provider the
 * name lives in the ledger and in what the read surfaces print; under a dns
 * provider it BECOMES the hostname, and a name minted today that could not be
 * one is a migration nobody signed up for.
 */
const EXPOSURE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function assertExposureName(name: string): string {
  if (!EXPOSURE_NAME_RE.test(name)) {
    throw new Error(
      `exposure name '${name}' is not a DNS label — lowercase letters, digits and dashes, ` +
        'starting and ending alphanumeric, at most 63 characters (every name must be a legal future hostname)',
    );
  }
  return name;
}

/**
 * The default name: `<service>-<env-short>`. The brief's `<env>-<service>`
 * cannot be spelled — an env id is `env-<uuid>`, 40 characters, and a DNS
 * label has 63 for the whole thing — so the env contributes the first eight
 * hex of its uuid, which is what makes the name unique without making it
 * unreadable. Anything the label grammar cannot carry is dropped rather than
 * mangled, and a service that reduces to nothing falls back to the port: a
 * name is an identity, never a guess at one.
 */
export function defaultExposureName(envId: string, service: string, port: number): string {
  const short = envId.replace(/^env-/, '').replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
  const label = service
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 40);
  return `${label || `port-${port}`}-${short || 'env'}`;
}

export class EnvExposureStore {
  constructor(private db: DbDriver) {}

  /**
   * The grant, PENDING: intent persisted before the provider is asked for
   * anything. The unique index is the name — a duplicate is a constraint
   * error here rather than a second serve entry out there.
   */
  async insertPending(row: {
    exposureId: string;
    name: string;
    envId: string;
    service: string;
    port: number;
    provider: string;
    providerDetail: Record<string, string>;
    url: string;
    ownerRef: string;
    approvedBy: string;
    claimantSessionId?: string | null;
  }): Promise<ExposureRow> {
    await this.db.run(
      `INSERT INTO env_exposures
         (exposure_id, name, env_id, service, port, provider, provider_detail, url, owner_ref, approved_by,
          state, claimant_session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      row.exposureId,
      row.name,
      row.envId,
      row.service,
      row.port,
      row.provider,
      JSON.stringify(row.providerDetail),
      row.url,
      row.ownerRef,
      row.approvedBy,
      row.claimantSessionId ?? null,
      new Date().toISOString(),
    );
    return (await this.get(row.exposureId))!;
  }

  async get(exposureId: string): Promise<ExposureRow | undefined> {
    const raw = await this.db.get<RawExposureRow>('SELECT * FROM env_exposures WHERE exposure_id = ?', exposureId);
    return raw ? toRow(raw) : undefined;
  }

  /**
   * This env's live-or-pending grants, oldest first — a LIST, because an env
   * is a whole live system and the names pointed at it are plural: a claimed
   * child answers as its chat UI and as its governance dashboard at once. The
   * read surfaces, the lifecycle revocation and the env-ready re-arm all have
   * to see every one of them, and a singular answer here would silently show,
   * revoke and re-assert only the oldest.
   *
   * An empty list is the ordinary answer for an env nobody has exposed.
   */
  async liveForEnv(envId: string): Promise<ExposureRow[]> {
    const raws = await this.db.all<RawExposureRow>(
      `SELECT * FROM env_exposures WHERE env_id = ? AND state IN ('pending','live') ORDER BY created_at`,
      envId,
    );
    return raws.map(toRow);
  }

  /**
   * Who holds this NAME right now, if anyone — the uniqueness the partial
   * index enforces, asked as a question. The index is still the guard (only
   * the database can settle two approved replays in one tick); this exists so
   * the refusal can name the holder instead of quoting a driver's constraint
   * error at an agent.
   */
  async liveForName(name: string): Promise<ExposureRow | undefined> {
    const raw = await this.db.get<RawExposureRow>(
      `SELECT * FROM env_exposures WHERE name = ? AND state IN ('pending','live')`,
      name,
    );
    return raw ? toRow(raw) : undefined;
  }

  /** Every live-or-pending grant — heal's worklist and the read surfaces' merge. */
  async listLive(): Promise<ExposureRow[]> {
    const raws = await this.db.all<RawExposureRow>(
      `SELECT * FROM env_exposures WHERE state IN ('pending','live') ORDER BY created_at`,
    );
    return raws.map(toRow);
  }

  async listForEnv(envId: string): Promise<ExposureRow[]> {
    const raws = await this.db.all<RawExposureRow>(
      'SELECT * FROM env_exposures WHERE env_id = ? ORDER BY created_at',
      envId,
    );
    return raws.map(toRow);
  }

  /**
   * Every row this provider ever wrote, ended ones LAST-REVOKED FIRST — the
   * allocation record a provider rebuilds its own state from without the
   * grant model ever reading inside `provider_detail`. Ended rows sort by
   * `revoked_at` ascending so the head of the list is the least recently
   * revoked: the tailnet provider's port pool, expressed as history.
   */
  async allocationHistory(provider: string): Promise<ExposureRow[]> {
    const raws = await this.db.all<RawExposureRow>(
      `SELECT * FROM env_exposures WHERE provider = ?
       ORDER BY CASE WHEN state IN ('pending','live') THEN 0 ELSE 1 END, revoked_at, created_at`,
      provider,
    );
    return raws.map(toRow);
  }

  /**
   * pending → live, with the URL the provider actually brought up — and only
   * from a row that is still live-or-pending, which is the same guard `revoke`
   * carries and for the same race. A provider's realize takes real time, and
   * a release, a reap or an unexpose can land inside it; without the guard
   * that ending is silently overwritten, a terminal row resurrects, and a
   * transport nobody is serving any more is reported live. Returns the row as
   * it stands, so the caller can see it did not win.
   */
  async markLive(exposureId: string, url: string): Promise<ExposureRow> {
    await this.db.run(
      `UPDATE env_exposures SET state = 'live', url = ? WHERE exposure_id = ? AND state IN ('pending','live')`,
      url,
      exposureId,
    );
    return (await this.get(exposureId))!;
  }

  /**
   * Terminal, and only from a live row: the reaper, an explicit unexpose and
   * a crashing env will race, and the ledger must keep the FIRST ending's
   * truth. Returns the row as it stands — unchanged when someone else won.
   */
  async revoke(exposureId: string, cause: ExposureRevokeCause): Promise<ExposureRow | undefined> {
    await this.db.run(
      `UPDATE env_exposures SET state = 'revoked', revoked_at = ?, revoke_cause = ?
       WHERE exposure_id = ? AND state IN ('pending','live')`,
      new Date().toISOString(),
      cause,
      exposureId,
    );
    return this.get(exposureId);
  }
}
