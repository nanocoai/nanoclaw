/**
 * Durable env registry — persistence (D12, D21).
 *
 * The registry is where env identity and instance identity split: `dev_envs`
 * rows outlive `dev_env_instances` rows (D21 — production is a stable env
 * identity over a succession of frozen instances; a dev claim is simply the
 * 1:1 case). What persists is identity, ownership, lifetime, and intent.
 * Endpoints and access deliberately do NOT persist: the runtime owns
 * realization, and adoption re-learns them from live handles — a row that
 * remembered a dead instance's URL would only be a lie waiting for a reader.
 *
 * `owner_ref` is opaque and carries no foreign key: the platform is
 * tenant-generic and an owner is whatever claimed the env. The host layer that
 * knows what an owner IS (an agent group, once code mode lands) owns the
 * coupling — including bound-lifetime release.
 */
import type { DbDriver } from '../db/driver.js';
import type { ModuleMigration } from '../db/migrations/index.js';
import { devEnvFailureDetail, type DevEnvFailure, type EnvLifetime } from './types.js';

/**
 * Every migration in this module is PORTABLE — `up(db: DbDriver)`, never
 * `sqliteOnly`. That is not a style choice, it is the only shape that can
 * deploy: `applyMigration` hard-throws `"…is SQLite-only; port it or provide a
 * backend migration override"` on any non-SQLite dialect, and the mechanism
 * that redeems `sqliteOnly` for the CORE barrel — each backend's baseline
 * generator — is structurally blind to modules
 * (`scripts/pg-baseline-from-sqlite.ts` seeds from the exported `migrations`
 * array; `registerMigration` pushes into a private `moduleMigrations` one). So
 * a SQLite-only MODULE migration has no route to a PostgreSQL host at all: it
 * is silently absent from the baseline and then refused by the runner.
 *
 * Two house rules follow, and both are load-bearing:
 *
 * 1. **BIGINT, never INTEGER**, for every integer column here. SQLite's
 *    INTEGER is 64-bit; PostgreSQL's is int4 (max 2_147_483_647). A bare
 *    INTEGER takes `expires_at_ms` (epoch milliseconds, ~1.79e12) out of range
 *    on the first `ttl` claim — and ONLY on a `ttl` claim, because `bound` and
 *    `pinned` write NULL there. It composes green, migrates green, and dies
 *    weeks later. BIGINT carries INTEGER affinity in SQLite, so one text
 *    serves both, and it is the width `schema-parity.test.ts` expects for
 *    every SQLite INTEGER.
 * 2. **Throw, never no-op**, on a dialect this module has no spelling for.
 *    A migration that silently skipped would be RECORDED IN `schema_version`
 *    AS APPLIED — a missing object reported as present. For
 *    `reserved-owner-ref` that is a missing security control reported as
 *    installed.
 */

/**
 * The 'operator' reservation, enforced where NO composition can strip it.
 * Host-CLI dev-env claims carry HOST_OWNER_REF as their ownerRef, and the D19
 * claimant route derives its pod selector from ownerRef verbatim — an agent
 * group wearing the name would satisfy the selector of every host-claimed
 * child's route. Worse, and dialect-independent: `ownerRef` is also the
 * driver's `materialsScope` (one owner's minted credentials live under it),
 * and `releaseBoundTo(ownerRef)` is called with the AGENT GROUP ID — a group
 * named `operator` flipping code mode off would release every bound
 * host-claimed env, on every driver, with no Kubernetes involved.
 *
 * A guard inside createAgentGroup cannot hold: recipe overlays
 * (skills/provisioning-substrate) REPLACE that function wholesale at compose,
 * so an in-body refusal is stripped in exactly the deployments that run
 * claims. A DB trigger rides the migration registry instead — every caller,
 * every composition, forever.
 *
 * This is the ONE migration in the module that a single SQL text cannot
 * express: a BEFORE INSERT refusal has no portable spelling. So the backends
 * get one spelling each and an unrecognized backend THROWS (house rule 2).
 *
 * The PostgreSQL arm is DROP-then-CREATE, not `CREATE TRIGGER IF NOT EXISTS`:
 * PostgreSQL has no such form (it is a syntax error), and a bare CREATE fails
 * `trigger "…" already exists` on any re-run. `CREATE OR REPLACE FUNCTION` +
 * `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` is re-runnable for free.
 *
 * Declared divergence, both spellings, on purpose: SQLite's `RAISE(ABORT)`
 * unwinds the statement and leaves the surrounding transaction usable;
 * PostgreSQL's `RAISE EXCEPTION` aborts the whole transaction, so every
 * following statement returns `current transaction is aborted` until rollback.
 * Same migration name, same green tests, different observable behaviour for a
 * caller that inserts groups in a batch — `skills/agent-migration`'s bundle
 * importer is the one live caller with caller-supplied ids.
 */
export const reservedOwnerRefMigration: ModuleMigration = {
  version: 2,
  name: 'module:dev-env:reserved-owner-ref',
  async up(db: DbDriver) {
    if (db.dialect === 'sqlite') {
      await db.exec(`
        CREATE TRIGGER IF NOT EXISTS dev_env_reserved_group_id
        BEFORE INSERT ON agent_groups
        WHEN NEW.id = 'operator'
        BEGIN
          SELECT RAISE(ABORT, 'agent group id ''operator'' is reserved for host-owned dev-env claims');
        END
      `);
      return;
    }
    if (db.dialect === 'postgres') {
      await db.exec(`
        CREATE OR REPLACE FUNCTION dev_env_reserved_group_id() RETURNS trigger
        LANGUAGE plpgsql AS $dev_env_reserved$
        BEGIN
          RAISE EXCEPTION 'agent group id ''operator'' is reserved for host-owned dev-env claims'
            USING ERRCODE = 'check_violation';
        END;
        $dev_env_reserved$;

        DROP TRIGGER IF EXISTS dev_env_reserved_group_id ON agent_groups;

        CREATE TRIGGER dev_env_reserved_group_id
        BEFORE INSERT ON agent_groups
        FOR EACH ROW WHEN (NEW.id = 'operator')
        EXECUTE FUNCTION dev_env_reserved_group_id();
      `);
      return;
    }
    throw new Error(
      `dev-env has no 'operator' reservation for central DB dialect "${db.dialect}"; ` +
        'port the trigger before deploying dev-env on this backend',
    );
  },
};

export const devEnvMigration: ModuleMigration = {
  version: 1,
  name: 'module:dev-env:envs',
  async up(db: DbDriver) {
    await db.exec(`
      CREATE TABLE dev_envs (
        env_id              TEXT PRIMARY KEY,
        owner_ref           TEXT NOT NULL,
        stamp_id            TEXT NOT NULL,
        driver_kind         TEXT NOT NULL,
        lifetime_mode       TEXT NOT NULL CHECK (lifetime_mode IN ('bound','ttl','pinned')),
        expires_at_ms       BIGINT,
        state               TEXT NOT NULL CHECK (state IN ('claiming','active','failed','released')),
        current_instance_id TEXT,
        claim_options       TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        released_at         TEXT,
        release_cause       TEXT
      );
      CREATE INDEX idx_dev_envs_live ON dev_envs(owner_ref) WHERE state IN ('claiming','active');
      CREATE TABLE dev_env_instances (
        instance_id  TEXT PRIMARY KEY,
        env_id       TEXT NOT NULL REFERENCES dev_envs(env_id),
        state        TEXT NOT NULL CHECK (state IN ('provisioning','ready','superseded','released','failed')),
        failure_kind TEXT,
        created_at   TEXT NOT NULL,
        terminal_at  TEXT
      );
      CREATE INDEX idx_dev_env_instances_env ON dev_env_instances(env_id);
    `);
  },
};

/**
 * Why a failed env failed, ON THE ROW (ISSUES #20, found in the whoami
 * acceptance: `envs get` on a failed env printed the one status line and
 * nothing else, and no host-log line carried the id). The taxonomy kind plus
 * the human-readable detail land at the same write that flips the state —
 * a failed row with no recorded reason is exactly the hole this closes.
 */
export const envFailureReasonMigration: ModuleMigration = {
  version: 4,
  name: 'module:dev-env:env-failure-reason',
  async up(db: DbDriver) {
    await db.exec(`ALTER TABLE dev_envs ADD COLUMN failure_kind TEXT`);
    await db.exec(`ALTER TABLE dev_envs ADD COLUMN failure_detail TEXT`);
  },
};

/**
 * WHO is waiting on this claim (D18): the claiming session's id, recorded on
 * the row so the readiness push survives a host restart — a claim re-adopted
 * mid-flight still knows which session to tell when it settles. Null for host
 * claims (an operator polls) and for claims that settled synchronously (the
 * claim response already carried the answer, so there is nobody left waiting).
 */
export const claimantSessionMigration: ModuleMigration = {
  version: 5,
  name: 'module:dev-env:claimant-session',
  async up(db: DbDriver) {
    await db.exec(`ALTER TABLE dev_envs ADD COLUMN claimant_session_id TEXT`);
  },
};

export type EnvState = 'claiming' | 'active' | 'failed' | 'released';
export type InstanceState = 'provisioning' | 'ready' | 'superseded' | 'released' | 'failed';
export type ReleaseCause = 'requested' | 'ttl-expired' | 'owner-released' | 'superseded' | 'adopt-reconcile';

export interface EnvRow {
  envId: string;
  ownerRef: string;
  stampId: string;
  /** Which registry definition realized the claim; null = a code-provided stamp. */
  stampVersion: number | null;
  driverKind: string;
  lifetime: EnvLifetime;
  state: EnvState;
  currentInstanceId: string | null;
  claimOptions: Record<string, string>;
  createdAt: string;
  releasedAt: string | null;
  releaseCause: ReleaseCause | null;
  /** Why a failed env failed: taxonomy kind + human detail. Null while live; cleared by succession. */
  failureKind: string | null;
  failureDetail: string | null;
  /** The session the D18 push tells when this claim settles; null = nobody waits. */
  claimantSessionId: string | null;
}

interface RawEnvRow {
  env_id: string;
  owner_ref: string;
  stamp_id: string;
  stamp_version: number | null;
  driver_kind: string;
  lifetime_mode: 'bound' | 'ttl' | 'pinned';
  expires_at_ms: number | null;
  state: EnvState;
  current_instance_id: string | null;
  claim_options: string;
  created_at: string;
  released_at: string | null;
  release_cause: ReleaseCause | null;
  failure_kind: string | null;
  failure_detail: string | null;
  claimant_session_id: string | null;
}

function toEnvRow(raw: RawEnvRow): EnvRow {
  return {
    envId: raw.env_id,
    ownerRef: raw.owner_ref,
    stampId: raw.stamp_id,
    stampVersion: raw.stamp_version ?? null,
    driverKind: raw.driver_kind,
    lifetime:
      raw.lifetime_mode === 'ttl' ? { mode: 'ttl', expiresAtMs: raw.expires_at_ms! } : { mode: raw.lifetime_mode },
    state: raw.state,
    currentInstanceId: raw.current_instance_id,
    claimOptions: JSON.parse(raw.claim_options) as Record<string, string>,
    createdAt: raw.created_at,
    releasedAt: raw.released_at,
    releaseCause: raw.release_cause,
    failureKind: raw.failure_kind ?? null,
    failureDetail: raw.failure_detail ?? null,
    claimantSessionId: raw.claimant_session_id ?? null,
  };
}

export class DevEnvStore {
  constructor(private db: DbDriver) {}

  async insertEnv(row: {
    envId: string;
    ownerRef: string;
    stampId: string;
    stampVersion?: number | null;
    driverKind: string;
    lifetime: EnvLifetime;
    instanceId: string;
    claimOptions: Record<string, string>;
  }): Promise<void> {
    const now = new Date().toISOString();
    // One transaction: the env row and its instance row are one fact. Split
    // commits let a crash (or a thrown second INSERT) persist a claiming env
    // whose instance has no ledger row — every later instance write would be
    // a zero-row UPDATE and the D21 succession record silently loses an entry.
    await this.db.transaction(async () => {
      await this.db.run(
        `INSERT INTO dev_envs
           (env_id, owner_ref, stamp_id, stamp_version, driver_kind, lifetime_mode, expires_at_ms, state,
            current_instance_id, claim_options, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'claiming', ?, ?, ?)`,
        row.envId,
        row.ownerRef,
        row.stampId,
        row.stampVersion ?? null,
        row.driverKind,
        row.lifetime.mode,
        row.lifetime.mode === 'ttl' ? row.lifetime.expiresAtMs : null,
        row.instanceId,
        JSON.stringify(row.claimOptions),
        now,
      );
      await this.insertInstance(row.instanceId, row.envId);
    });
  }

  async insertInstance(instanceId: string, envId: string): Promise<void> {
    await this.db.run(
      `INSERT INTO dev_env_instances (instance_id, env_id, state, created_at) VALUES (?, ?, 'provisioning', ?)`,
      instanceId,
      envId,
      new Date().toISOString(),
    );
  }

  async getEnv(envId: string): Promise<EnvRow | undefined> {
    const raw = await this.db.get<RawEnvRow>('SELECT * FROM dev_envs WHERE env_id = ?', envId);
    return raw ? toEnvRow(raw) : undefined;
  }

  async listEnvs(filter: { states?: EnvState[]; ownerRef?: string } = {}): Promise<EnvRow[]> {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.states?.length) {
      clauses.push(`state IN (${filter.states.map(() => '?').join(',')})`);
      params.push(...filter.states);
    }
    if (filter.ownerRef) {
      clauses.push('owner_ref = ?');
      params.push(filter.ownerRef);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const raws = await this.db.all<RawEnvRow>(`SELECT * FROM dev_envs${where} ORDER BY created_at`, ...params);
    return raws.map(toEnvRow);
  }

  async setEnvState(envId: string, state: EnvState): Promise<void> {
    await this.db.run('UPDATE dev_envs SET state = ? WHERE env_id = ?', state, envId);
  }

  async markReleased(envId: string, cause: ReleaseCause): Promise<void> {
    await this.db.run(
      `UPDATE dev_envs SET state = 'released', released_at = ?, release_cause = ? WHERE env_id = ?`,
      new Date().toISOString(),
      cause,
      envId,
    );
  }

  /** The failed-state twin of markReleased: the reason lands with the flip, never as a second commit (#20). */
  async markFailed(envId: string, failure: DevEnvFailure): Promise<void> {
    await this.db.run(
      `UPDATE dev_envs SET state = 'failed', failure_kind = ?, failure_detail = ? WHERE env_id = ?`,
      failure.kind,
      devEnvFailureDetail(failure),
      envId,
    );
  }

  async extendTtl(envId: string, expiresAtMs: number): Promise<void> {
    await this.db.run('UPDATE dev_envs SET expires_at_ms = ? WHERE env_id = ?', expiresAtMs, envId);
  }

  /**
   * Arm the D18 push: record the session to tell when this claim settles.
   * Written only while the claim is still in flight when `claim` returns — a
   * synchronous answer needs no push, and never promising one it will not
   * send is what keeps the claim response's contract honest.
   */
  async setClaimantSession(envId: string, sessionId: string): Promise<void> {
    await this.db.run('UPDATE dev_envs SET claimant_session_id = ? WHERE env_id = ?', sessionId, envId);
  }

  /** The succession primitive (D21): a new instance under the same env identity. */
  async bindNewInstance(envId: string, instanceId: string): Promise<void> {
    // Transactional for the same reason as insertEnv: supersession, the new
    // ledger row, and the env's current-instance pointer are one fact.
    await this.db.transaction(async () => {
      const previous = await this.db.get<{ current_instance_id: string | null }>(
        'SELECT current_instance_id FROM dev_envs WHERE env_id = ?',
        envId,
      );
      if (previous?.current_instance_id) {
        // Only a LIVE row is superseded — an instance that already ended keeps
        // the truth of how it ended ('failed' stays 'failed').
        await this.db.run(
          `UPDATE dev_env_instances SET state = 'superseded', terminal_at = ?
           WHERE instance_id = ? AND state IN ('provisioning','ready')`,
          new Date().toISOString(),
          previous.current_instance_id,
        );
      }
      await this.insertInstance(instanceId, envId);
      // Succession clears the previous instance's verdict from the ENV row —
      // the instance ledger keeps it (failure_kind on dev_env_instances); the
      // env row speaks only for the instance that currently realizes it.
      await this.db.run(
        `UPDATE dev_envs SET current_instance_id = ?, state = 'claiming', failure_kind = NULL, failure_detail = NULL
         WHERE env_id = ?`,
        instanceId,
        envId,
      );
    });
  }

  /**
   * Terminal transition that only lands on a live row: the reaper, an explicit
   * release, and a crash event will race, and the row must keep the FIRST
   * ending's truth — a 'failed' instance must not be rewritten 'released' by a
   * cleanup that arrived second.
   */
  async settleInstanceIfLive(instanceId: string, state: 'released' | 'failed', failure?: DevEnvFailure): Promise<void> {
    await this.db.run(
      `UPDATE dev_env_instances SET state = ?, failure_kind = ?, terminal_at = ?
       WHERE instance_id = ? AND state IN ('provisioning','ready')`,
      state,
      failure?.kind ?? null,
      new Date().toISOString(),
      instanceId,
    );
  }

  async setInstanceState(instanceId: string, state: InstanceState, failure?: DevEnvFailure): Promise<void> {
    const terminal = state === 'ready' || state === 'provisioning' ? null : new Date().toISOString();
    await this.db.run(
      'UPDATE dev_env_instances SET state = ?, failure_kind = ?, terminal_at = ? WHERE instance_id = ?',
      state,
      failure?.kind ?? null,
      terminal,
      instanceId,
    );
  }

  async listInstances(envId: string): Promise<Array<{ instanceId: string; state: InstanceState }>> {
    const rows = await this.db.all<{ instance_id: string; state: InstanceState }>(
      'SELECT instance_id, state FROM dev_env_instances WHERE env_id = ? ORDER BY created_at',
      envId,
    );
    return rows.map((r) => ({ instanceId: r.instance_id, state: r.state }));
  }
}
