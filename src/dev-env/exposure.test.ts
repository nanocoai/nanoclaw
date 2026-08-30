/**
 * Exposures (C14) — the grant model, against a stub provider.
 *
 * The suite is deliberately transport-free: everything here is a NAME, a
 * TARGET and a lifecycle, and the only thing a provider contributes is four
 * calls. That is also the DNS-readiness claim, and the last block proves it
 * literally — a second provider registers, carries the same grant, and every
 * ledger column except provider/url/detail comes out byte-identical.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import type { DbDriver } from '../db/driver.js';
import { runMigrations } from '../db/migrations/index.js';
import { log } from '../log.js';

import {
  EnvExposureStore,
  assertExposureName,
  defaultExposureName,
  type ExposureRow,
} from './exposure.js';
import {
  getExposureProviderFactory,
  registerExposureProvider,
  type ExposureBinding,
  type ExposureDraft,
  type ExposureGrant,
  type ExposureProvider,
} from './exposure-provider.js';
import { EnvExposureService, wireExposurePush, type ExposureTlsProbe } from './exposure-service.js';
// Side-effect: registers the dev-env migrations, so runMigrations' default
// list covers env_exposures — the house archetype.
import './index.js';
import { MockDevEnvDriver, MockDevEnvRuntime, instanceName } from './mock-driver.js';
import { DevEnvService } from './service.js';
import type { ExposureTargetResolution } from './types.js';

const INSTALL = 'exposure-suite';
const STAMP = 'sample-app';

/**
 * A provider that records what the grant model asked of it. Deliberately
 * dumb: the point of the seam is that the model below needs nothing else.
 */
class StubProvider implements ExposureProvider {
  readonly realized: string[] = [];
  /** Every revoke, with what the runtime looked like AT THAT MOMENT — the ordering proof. */
  readonly revoked: Array<{ name: string; instancesAlive: number }> = [];
  readonly healed: string[][] = [];
  /** What heal treated as a STRAY — the contract's entitlement, exercised. */
  readonly reaped: string[] = [];
  /** The probed scheme as the DRAFT carried it — reportUrl is where a provider is told. */
  readonly backendTls = new Map<string, boolean | undefined>();
  readonly bindings = new Map<string, ExposureBinding>();
  failRealize: string | null = null;
  unavailable: string | null = null;
  /** Parks realize, so a test can land an ending INSIDE the provider's window. */
  beforeRealize: (() => Promise<void>) | null = null;
  /** Names whose transport teardown refuses — the row that will not close. */
  readonly revokeThrowsFor = new Set<string>();

  constructor(
    readonly kind = 'stub',
    private aliveNow: () => number = () => -1,
  ) {}

  unavailableReason(): string | null {
    return this.unavailable;
  }

  reportUrl(draft: ExposureDraft, history: ExposureRow[]): { url: string; detail: Record<string, string> } {
    if (this.unavailable) throw new Error(this.unavailable);
    this.backendTls.set(draft.name, draft.backendTls);
    // Kept in the private column, the way the tailnet provider keeps it: the
    // draft is the ONE moment a provider is told the target's scheme, because
    // it is not a row column and `grantOf` therefore cannot carry it into a
    // later realize or heal.
    return {
      url: `https://${draft.name}.${this.kind}.invalid/`,
      detail: { seq: String(history.length), backendTls: String(draft.backendTls === true) },
    };
  }

  async realize(binding: ExposureBinding): Promise<{ url: string }> {
    if (this.beforeRealize) await this.beforeRealize();
    if (this.failRealize) throw new Error(this.failRealize);
    this.bindings.set(binding.grant.name, binding);
    this.realized.push(binding.grant.name);
    return { url: binding.grant.url };
  }

  async revoke(grant: ExposureGrant): Promise<void> {
    this.revoked.push({ name: grant.name, instancesAlive: this.aliveNow() });
    this.bindings.delete(grant.name);
    if (this.revokeThrowsFor.has(grant.name)) throw new Error(`transport teardown refused for '${grant.name}'`);
  }

  /**
   * Reads its argument the way the contract entitles it to: the COMPLETE live
   * set. Anything this provider is carrying that the set does not name is a
   * stray, and closing strays is half of what heal is for — which is exactly
   * why a caller may never hand over a subset.
   */
  async heal(bindings: ExposureBinding[]): Promise<void> {
    this.healed.push(bindings.map((binding) => binding.grant.name));
    const live = new Set(bindings.map((binding) => binding.grant.name));
    for (const name of [...this.bindings.keys()]) {
      if (live.has(name)) continue;
      this.bindings.delete(name);
      this.reaped.push(name);
    }
    for (const binding of bindings) this.bindings.set(binding.grant.name, binding);
  }
}

/**
 * The target's scheme, stubbed — the one thing in this suite that is NOT
 * transport-free, because the production probe opens real sockets to the
 * resolved address (see `ExposureTlsProbe`). Nothing here serves one, so
 * without this every grant in the file would refuse, exactly as the service
 * documents. It is a control, not a silencer: what it was asked and what its
 * answer reaches are both asserted in `the grant`.
 */
interface StubProbe {
  /** Every target a grant asked about, in order. */
  readonly asked: ExposureTargetResolution[];
  /** What the next probe answers; an Error is THROWN, which is how a probe refuses. */
  answer: boolean | Error;
  probe: ExposureTlsProbe;
}

function stubProbe(): StubProbe {
  const self: StubProbe = {
    asked: [],
    answer: false,
    probe: async (target) => {
      self.asked.push(target);
      if (self.answer instanceof Error) throw self.answer;
      return self.answer;
    },
  };
  return self;
}

interface Fixture {
  db: DbDriver;
  runtime: MockDevEnvRuntime;
  envs: DevEnvService;
  provider: StubProvider;
  probe: StubProbe;
  exposures: EnvExposureService;
  store: EnvExposureStore;
  clock: { now: () => number; advance: (ms: number) => void };
}

let fx: Fixture;

async function claim(lifetime: Parameters<DevEnvService['claim']>[0]['lifetime'] = { mode: 'pinned' }): Promise<{
  envId: string;
  instance: string;
}> {
  const env = await fx.envs.claim({ ownerRef: 'g-agent', stampId: STAMP, lifetime });
  const instance = instanceName({ envId: env.envId, instanceId: env.instanceId! });
  fx.runtime.publishService(instance, { service: 'default/backlot', address: '10.43.0.9', port: 8080 });
  return { envId: env.envId, instance };
}

/**
 * A runtime transition fires the seam's synchronous callback, but everything
 * it triggers — the ending hooks, the registry writes — is I/O. Poll rather
 * than count ticks: the number of awaits between a kill and a revoked row is
 * an implementation detail, and hard-coding it makes the suite brittle.
 */
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`never settled: ${what}`);
}

async function makeFixture(provider = new StubProvider()): Promise<Fixture> {
  const db = await initTestDb();
  await runMigrations(db);
  const runtime = new MockDevEnvRuntime();
  let t = 1_000_000;
  const envs = new DevEnvService({
    db,
    driver: new MockDevEnvDriver({ installScope: INSTALL, runtime, knownStamps: [STAMP] }),
    installScope: INSTALL,
    now: () => t,
  });
  const probe = stubProbe();
  const exposures = new EnvExposureService({ db, envs, provider, probeBackendTls: probe.probe });
  exposures.wireLifecycle();
  return {
    db,
    runtime,
    envs,
    provider,
    probe,
    exposures,
    store: new EnvExposureStore(db),
    clock: { now: () => t, advance: (ms) => (t += ms) },
  };
}

beforeEach(async () => {
  fx = await makeFixture(new StubProvider('stub', () => fx.runtime.instances.size));
});

afterEach(async () => {
  fx.exposures.stop();
  await closeDb();
});

describe('the name', () => {
  it('is a DNS label or it is refused — every v1 name must already be a legal hostname', () => {
    expect(assertExposureName('backlot-3f2a19bd')).toBe('backlot-3f2a19bd');
    for (const bad of ['Backlot', 'has_underscore', '-leading', 'trailing-', '', 'a'.repeat(64), 'a b']) {
      expect(() => assertExposureName(bad), bad).toThrow(/DNS label/);
    }
  });

  it("derives `<service>-<env-short>` — the brief's `<env>-<service>` cannot be spelled in 63 characters", () => {
    const name = defaultExposureName('env-3f2a19bd-1111-2222-3333-444455556666', 'default/backlot', 8080);
    expect(assertExposureName(name)).toBe('default-backlot-3f2a19bd');
    // A service that reduces to nothing falls back to the port rather than
    // minting an identity out of an empty string.
    expect(defaultExposureName('env-abcdef12', '///', 8080)).toBe('port-8080-abcdef12');
  });
});

describe('the grant', () => {
  it('freezes the resolved service, states the URL, and lands the row live', async () => {
    const { envId } = await claim();
    const row = await fx.exposures.expose({ envId, port: 8080, approvedBy: 'g-agent' });

    expect(row).toMatchObject({
      state: 'live',
      envId,
      // Resolved from the port alone and FROZEN in canonical form: the row,
      // the reads and the grant's answer all name one concrete service, and
      // no later dial ever scans ports again.
      service: 'default/backlot',
      port: 8080,
      provider: 'stub',
      ownerRef: 'g-agent',
      approvedBy: 'g-agent',
    });
    expect(row.url).toBe(`https://${row.name}.stub.invalid/`);
    expect(fx.provider.realized).toEqual([row.name]);
  });

  it("probes the target's scheme once, hands the answer to the provider, and refuses when it cannot be had", async () => {
    const { envId } = await claim();
    fx.probe.answer = true;
    const row = await fx.exposures.expose({ envId, port: 8080, approvedBy: 'operator' });

    // Asked ONCE, about the address the driver had just resolved — not about
    // the env, the name, or anything the row will end up carrying.
    expect(fx.probe.asked).toEqual([{ service: 'default/backlot', address: '10.43.0.9', port: 8080 }]);
    // The answer stops at the PROVIDER, and at reportUrl specifically: it is
    // deliberately not a row column, so this is the only moment a provider is
    // told — hence the tailnet provider writing it into its private column,
    // which the stub mirrors. A provider that ignored the draft would keep
    // dialling http at a target that speaks TLS and 502 forever.
    expect(fx.provider.backendTls.get(row.name)).toBe(true);
    expect(row.providerDetail.backendTls).toBe('true');

    // A target that will not answer is the ABSENCE of evidence, not evidence
    // of plaintext: the grant refuses rather than freezing a guess that would
    // answer an empty 502 for the rest of the row's life.
    const other = await claim();
    fx.probe.answer = new Error('no answer within 3000ms');
    await expect(fx.exposures.expose({ envId: other.envId, port: 8080, approvedBy: 'operator' })).rejects.toThrow(
      /did not answer at 10\.43\.0\.9/,
    );
    // And it refuses BEFORE the row, like every other grant-time refusal:
    // nothing to audit, nothing for heal to pick up.
    expect(await fx.exposures.history(other.envId)).toEqual([]);
  });

  it('allows a SECOND exposure on the same env under a different name, and still refuses a duplicate NAME', async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE — "refuses a second exposure on the
    // same env, naming how to close the first" — and the inversion is the whole
    // change, not a relaxation. An env is a live system, not a single page: a
    // claimed child has to answer as its chat UI AND as its governance
    // dashboard at once, and under the old rule the second grant died at the
    // database where the caller wanted a second NAME.
    //
    // Uniqueness moved to the name, which is already the ledger key, already
    // the subject of the approval and already the future hostname. So the
    // refusal did not go away; it moved, and both halves are asserted here.
    const { envId, instance } = await claim();
    // The child really does serve both — `claim` publishes only the app port,
    // so the dashboard has to exist before a grant onto it can mean anything.
    fx.runtime.publishService(instance, { service: 'default/dash', address: '10.43.0.9', port: 9090 });
    const first = await fx.exposures.expose({ envId, port: 8080, name: 'chat', approvedBy: 'operator' });
    const second = await fx.exposures.expose({ envId, port: 9090, name: 'dashboard', approvedBy: 'operator' });
    expect(second.state).toBe('live');
    expect(second.service).toBe('default/dash');
    expect((await fx.exposures.liveForEnv(envId)).map((row) => row.name).sort()).toEqual(['chat', 'dashboard']);

    // The NAME is what cannot be doubled — two live grants on one name is two
    // serve entries claiming one hostname. The port is one the env DOES serve,
    // so the refusal can only be about the name.
    await expect(
      fx.exposures.expose({ envId, port: 8080, name: first.name, approvedBy: 'operator' }),
    ).rejects.toThrow(/chat/);

    // And a revoked name is re-mintable — that is what the partial WHERE on the
    // name index buys, and it is why the index is partial rather than total.
    await fx.exposures.unexpose(envId, 'chat');
    const again = await fx.exposures.expose({ envId, port: 8080, name: 'chat', approvedBy: 'operator' });
    expect(again.state).toBe('live');
  });

  it('refuses to guess between two services on one port, and takes --service instead', async () => {
    const { envId, instance } = await claim();
    fx.runtime.publishService(instance, { service: 'default/twin', address: '10.43.0.10', port: 8080 });

    await expect(fx.exposures.expose({ envId, port: 8080, approvedBy: 'operator' })).rejects.toThrow(
      /2 services serve port 8080/,
    );
    const row = await fx.exposures.expose({ envId, port: 8080, service: 'default/twin', approvedBy: 'operator' });
    expect(row.service).toBe('default/twin');
  });

  it('refuses a port nothing serves, a foreign service name, and a non-active env', async () => {
    const { envId } = await claim();
    await expect(fx.exposures.expose({ envId, port: 9999, approvedBy: 'operator' })).rejects.toThrow(
      /nothing in env .* serves port 9999/,
    );
    await expect(
      fx.exposures.expose({ envId, port: 8080, service: 'default/ghost', approvedBy: 'operator' }),
    ).rejects.toThrow(/no service 'default\/ghost'/);

    await fx.envs.release(envId);
    await expect(fx.exposures.expose({ envId, port: 8080, approvedBy: 'operator' })).rejects.toThrow(
      /is released — only an active env can be exposed/,
    );
  });

  it('refuses when the driver cannot resolve targets at all — never a URL nothing carries', async () => {
    const db = await initTestDb();
    await runMigrations(db);
    const runtime = new MockDevEnvRuntime();
    const envs = new DevEnvService({
      db,
      driver: new MockDevEnvDriver({
        installScope: INSTALL,
        runtime,
        knownStamps: [STAMP],
        resolvesExposureTargets: false,
      }),
      installScope: INSTALL,
    });
    const exposures = new EnvExposureService({ db, envs, provider: new StubProvider() });
    const env = await envs.claim({ ownerRef: 'g', stampId: STAMP, lifetime: { mode: 'pinned' } });
    await expect(exposures.expose({ envId: env.envId, port: 8080, approvedBy: 'operator' })).rejects.toThrow(
      /does not resolve exposure targets/,
    );
    // Nothing was written: a refusal at grant leaves no row to audit or heal.
    expect(await new EnvExposureStore(db).listLive()).toEqual([]);
  });

  it('a failed realize takes the grant with it — no URL is left advertised that does not serve', async () => {
    const { envId } = await claim();
    fx.provider.failRealize = 'serve refused: no operator grant';
    await expect(fx.exposures.expose({ envId, port: 8080, approvedBy: 'operator' })).rejects.toThrow(/serve refused/);

    const rows = await fx.exposures.history(envId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'revoked', revokeCause: 'realize-failed' });
    // The slot and the name are free again, and the next grant succeeds.
    fx.provider.failRealize = null;
    expect((await fx.exposures.expose({ envId, port: 8080, approvedBy: 'operator' })).state).toBe('live');
  });

  it('an ending that lands INSIDE a slow realize stays won — no terminal row is resurrected as live', async () => {
    const { envId } = await claim();
    let unpark!: () => void;
    const parked = new Promise<void>((resolve) => (unpark = resolve));
    fx.provider.beforeRealize = () => parked;

    // The grant is in the provider's hands; the row is `pending` in the ledger.
    const granting = fx.exposures.expose({ envId, port: 8080, approvedBy: 'operator' });
    await until(async () => (await fx.exposures.liveForEnv(envId))[0]?.state === 'pending', 'the pending row to land');

    // The env ends in that window — release, a reap and a crash all can.
    await fx.envs.release(envId);
    unpark();

    await expect(granting).rejects.toThrow(/was revoked \(released\) while it was being realized/);
    const rows = await fx.exposures.history(envId);
    expect(rows).toHaveLength(1);
    // The FIRST ending's truth, kept: cause and all. A `live` row here would
    // be a dead transport advertised as serving.
    expect(rows[0]).toMatchObject({ state: 'revoked', revokeCause: 'released' });
    // ...and the transport that came up behind the revocation is torn down
    // rather than left listening.
    expect(fx.provider.revoked.map((entry) => entry.name)).toEqual([rows[0].name, rows[0].name]);
  });
});

describe('the name and target outlive instances (D21)', () => {
  it('supersession parks the exposure: same row, same URL, no fresh approval — and nothing stale answers in the gap', async () => {
    const { envId } = await claim();
    const row = await fx.exposures.expose({ envId, port: 8080, approvedBy: 'operator' });
    const dial = fx.provider.bindings.get(row.name)!.dial;
    expect(await dial()).toMatchObject({ address: '10.43.0.9' });

    // reclaimInstance: the old instance ends under a LIVE env. That is not an
    // ending — the grant must survive it untouched.
    const after = await fx.envs.reclaimInstance(envId);
    // ONE row, and the length is asserted rather than indexed past: an env may
    // hold several grants now, and `toMatchObject` on element 0 alone would
    // pass just as happily if a reclaim had somehow minted a second.
    const current = await fx.exposures.liveForEnv(envId);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ exposureId: row.exposureId, name: row.name, url: row.url, state: 'live' });
    expect(fx.provider.revoked).toEqual([]);
    // During the gap the successor serves nothing yet: the dial MISSES rather
    // than answering with the address the predecessor had.
    expect(await dial()).toBeNull();

    // env-ready re-arms it: same name, same URL, same row.
    const successor = instanceName({ envId, instanceId: after.instanceId! });
    fx.runtime.publishService(successor, { service: 'default/backlot', address: '10.43.0.77', port: 8080 });
    expect(await dial()).toMatchObject({ address: '10.43.0.77', service: 'default/backlot' });
    expect((await fx.exposures.liveForEnv(envId))[0]?.exposureId).toBe(row.exposureId);
  });

  it('live drift inside the child: the same name at a NEW address, resolved per call', async () => {
    const { envId, instance } = await claim();
    const row = await fx.exposures.expose({ envId, port: 8080, approvedBy: 'operator' });
    const dial = fx.provider.bindings.get(row.name)!.dial;

    // The agent deletes and recreates its Service — same name, new ClusterIP.
    fx.runtime.dropService(instance, 'default/backlot');
    expect(await dial()).toBeNull();
    fx.runtime.publishService(instance, { service: 'default/backlot', address: '10.43.0.55', port: 8080 });
    expect(await dial()).toMatchObject({ address: '10.43.0.55' });
    // The ledger never learned any of it — no address is written down.
    expect((await fx.exposures.liveForEnv(envId))[0]).toMatchObject({ url: row.url, service: 'default/backlot' });
  });
});

describe('revocation is lifecycle, not a feature', () => {
  it('release revokes FIRST — reachability never outlives the instance', async () => {
    const { envId } = await claim();
    await fx.exposures.expose({ envId, port: 8080, approvedBy: 'operator' });

    await fx.envs.release(envId);

    // The provider's revoke ran while the instance was still up (1 alive),
    // which is the closeClaimRoute ordering: the hole closes before teardown.
    expect(fx.provider.revoked).toHaveLength(1);
    expect(fx.provider.revoked[0].instancesAlive).toBe(1);
    expect(fx.runtime.instances.size).toBe(0);
    expect(await fx.exposures.liveForEnv(envId)).toEqual([]);
    expect((await fx.exposures.history(envId))[0]).toMatchObject({ state: 'revoked', revokeCause: 'released' });
  });

  it('a TTL reap takes the exposure with it, unasked', async () => {
    const { envId } = await claim({ mode: 'ttl', ttlMs: 60_000 });
    await fx.exposures.expose({ envId, port: 8080, approvedBy: 'operator' });

    fx.clock.advance(61_000);
    await fx.envs.reapExpired();

    expect((await fx.exposures.history(envId))[0]).toMatchObject({ state: 'revoked', revokeCause: 'released' });
    expect(fx.provider.revoked).toHaveLength(1);
  });

  it('a failed env revokes with its own cause — a failed env has no reachability to keep', async () => {
    const { envId, instance } = await claim();
    await fx.exposures.expose({ envId, port: 8080, approvedBy: 'operator' });

    fx.runtime.kill(instance);
    await until(async () => (await fx.envs.status(envId)).state === 'failed', 'the env to fail');

    expect((await fx.envs.status(envId)).state).toBe('failed');
    expect((await fx.exposures.history(envId))[0]).toMatchObject({ state: 'revoked', revokeCause: 'env-failed' });
  });

  it('retiring the stamp closes the holes onto it and leaves the env running', async () => {
    const { envId } = await claim();
    await fx.exposures.expose({ envId, port: 8080, approvedBy: 'operator' });

    const revoked = await fx.exposures.revokeForStamp(STAMP);

    expect(revoked.map((row) => row.revokeCause)).toEqual(['stamp-retired']);
    expect(await fx.exposures.liveForEnv(envId)).toEqual([]);
    // The stamps contract is unchanged: the env itself is untouched.
    expect((await fx.envs.status(envId)).state).toBe('active');
  });

  it('one hole that will not close does not abandon the rest, and its log names a TRUE remediation', async () => {
    const first = await claim();
    const second = await claim();
    const stuck = await fx.exposures.expose({ envId: first.envId, port: 8080, approvedBy: 'operator' });
    const rest = await fx.exposures.expose({ envId: second.envId, port: 8080, approvedBy: 'operator' });
    // The first row's transport refuses to come down (a tailscaled that is
    // not answering, a privilege that was revoked under us).
    fx.provider.revokeThrowsFor.add(stuck.name);
    const warn = vi.spyOn(log, 'warn');

    const revoked = await fx.exposures.revokeForStamp(STAMP);

    // The loop kept going: the other hole closed.
    expect(revoked.map((row) => row.name)).toEqual([rest.name]);
    expect(await fx.exposures.liveForEnv(second.envId)).toEqual([]);
    // The ledger ended the stuck row too — the row is the audit trail
    // whatever the transport did.
    expect((await fx.exposures.history(first.envId))[0]).toMatchObject({ state: 'revoked' });

    // ...which is exactly why the log may NOT send an operator to `unexpose`:
    // the live row that command reads is the one this ending removed, so it
    // would answer "exposes nothing" and touch no transport at all.
    expect(await fx.exposures.unexpose(first.envId)).toEqual([]);
    // Two teardowns, both from the retire — the unexpose added none.
    expect([...fx.provider.revoked.map((entry) => entry.name)].sort()).toEqual([stuck.name, rest.name].sort());
    const named = warn.mock.calls.find(
      ([message, data]) =>
        String(message).includes('could not close an exposure onto a retired stamp') &&
        (data as { exposure?: string } | undefined)?.exposure === stuck.name,
    );
    const detail = named?.[1] as { ledger?: string; fix?: string } | undefined;
    expect(detail?.ledger).toBe('revoked');
    expect(detail?.fix).toContain("provider's heal");
    expect(detail?.fix).not.toContain('unexpose');
    warn.mockRestore();
  });

  it('unexpose is idempotent and answers nothing when there is nothing to close', async () => {
    const { envId } = await claim();
    await fx.exposures.expose({ envId, port: 8080, approvedBy: 'operator' });
    // `unexpose(envId)` with no name revokes EVERY live grant on the env and
    // returns them all — an env may hold several now. Asserting the length as
    // well as the cause is what keeps this a statement about "the one grant we
    // made" rather than "at least one of whatever was there".
    const ended = await fx.exposures.unexpose(envId);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.revokeCause).toBe('requested');
    // And it is idempotent: nothing live left to end.
    expect(await fx.exposures.unexpose(envId)).toEqual([]);
  });
});

describe('heal', () => {
  it('realizes a grant whose realize never finished, then hands the provider every live binding', async () => {
    const { envId } = await claim();
    // A host that died between the row and the realize: exactly what the
    // intent-first ordering leaves behind.
    await fx.store.insertPending({
      exposureId: 'expo-orphan',
      name: 'orphan-1',
      envId,
      service: 'default/backlot',
      port: 8080,
      provider: 'stub',
      providerDetail: { seq: '0' },
      url: 'https://orphan-1.stub.invalid/',
      ownerRef: 'g-agent',
      approvedBy: 'operator',
    });

    await fx.exposures.heal();

    expect((await fx.exposures.liveForEnv(envId))[0]?.state).toBe('live');
    expect(fx.provider.realized).toEqual(['orphan-1']);
    expect(fx.provider.healed.at(-1)).toEqual(['orphan-1']);
  });

  it("one env's re-arm hands the provider the COMPLETE live set — the other env keeps serving", async () => {
    // `heal(bindings)` is documented as the whole live set, which is what
    // entitles a provider to read an absence as a stray. A per-env re-arm that
    // handed over one env's row would therefore not be a smaller heal: it
    // would be an instruction to close every OTHER exposure on the box.
    const a = await claim();
    const b = await claim();
    const staysUp = await fx.exposures.expose({ envId: a.envId, port: 8080, approvedBy: 'operator' });
    const rearmed = await fx.exposures.expose({ envId: b.envId, port: 8080, approvedBy: 'operator' });

    // B's instance is superseded and the successor comes ready: the env-ready
    // re-arm, with A untouched and live throughout.
    const after = await fx.envs.reclaimInstance(b.envId);
    fx.runtime.publishService(instanceName({ envId: b.envId, instanceId: after.instanceId! }), {
      service: 'default/backlot',
      address: '10.43.0.77',
      port: 8080,
    });
    await until(async () => (fx.provider.healed.at(-1)?.length ?? 0) > 0, 'the re-arm to reach the provider');

    expect([...(fx.provider.healed.at(-1) ?? [])].sort()).toEqual([staysUp.name, rearmed.name].sort());
    // The other env's transport was never handed to the provider as an absence.
    expect(fx.provider.reaped).toEqual([]);
    expect(fx.provider.bindings.has(staysUp.name)).toBe(true);
    expect(await fx.provider.bindings.get(staysUp.name)!.dial()).toMatchObject({ address: '10.43.0.9' });
    expect((await fx.exposures.liveForEnv(a.envId))[0]?.state).toBe('live');
  });

  it('a pending grant that still cannot realize goes terminal with its reason rather than wedging heal', async () => {
    const { envId } = await claim();
    await fx.store.insertPending({
      exposureId: 'expo-doomed',
      name: 'doomed-1',
      envId,
      service: 'default/backlot',
      port: 8080,
      provider: 'stub',
      providerDetail: {},
      url: 'https://doomed-1.stub.invalid/',
      ownerRef: 'g-agent',
      approvedBy: 'operator',
    });
    fx.provider.failRealize = 'tailnet-privilege: this host user may not run tailscale serve';

    await fx.exposures.heal();

    expect((await fx.exposures.history(envId))[0]).toMatchObject({ state: 'revoked', revokeCause: 'realize-failed' });
    expect(fx.provider.healed.at(-1)).toEqual([]);
  });
});

describe('a row another provider wrote is not this install to carry', () => {
  it('is skipped at heal and ended in the ledger without a transport call', async () => {
    // The state after an operator switches NANOCLAW_DEV_ENV_EXPOSURE_PROVIDER:
    // rows written by the previous kind are still in the ledger, and their
    // `provider_detail` means nothing to the configured provider.
    const { envId } = await claim();
    await fx.store.insertPending({
      exposureId: 'expo-foreign',
      name: 'foreign-1',
      envId,
      service: 'default/backlot',
      port: 8080,
      provider: 'dns-elsewhere',
      providerDetail: { zone: 'example.invalid' },
      url: 'https://foreign-1.example.invalid/',
      ownerRef: 'g-agent',
      approvedBy: 'operator',
    });

    await fx.exposures.heal();

    // Not realized and not re-asserted: this provider cannot bring up a
    // transport it did not write, and guessing would misroute.
    expect(fx.provider.realized).toEqual([]);
    expect(fx.provider.healed.at(-1)).toEqual([]);
    expect((await fx.exposures.liveForEnv(envId))[0]?.state).toBe('pending');

    // The LEDGER still ends it — the row is the audit trail either way —
    // while the transport is left to the provider that owns it.
    const ended = await fx.exposures.unexpose(envId);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ name: 'foreign-1', state: 'revoked', revokeCause: 'requested' });
    expect(fx.provider.revoked).toEqual([]);
  });

  it('says so ONCE per row, not once per heal tick', async () => {
    // Heal runs over every live row every 60s and a foreign row does not
    // change until somebody acts on it: a line per row per tick would bury
    // the log an operator is supposed to find this in.
    const { envId } = await claim();
    await fx.store.insertPending({
      exposureId: 'expo-foreign-loud',
      name: 'foreign-2',
      envId,
      service: 'default/backlot',
      port: 8080,
      provider: 'dns-elsewhere',
      providerDetail: { zone: 'example.invalid' },
      url: 'https://foreign-2.example.invalid/',
      ownerRef: 'g-agent',
      approvedBy: 'operator',
    });
    const warn = vi.spyOn(log, 'warn');

    await fx.exposures.heal();
    await fx.exposures.heal();
    await fx.exposures.heal();

    // Keyed to THIS row: a previous test's service can still be finishing an
    // async heal of its own foreign row while this one runs.
    const lines = warn.mock.calls.filter(
      ([message, data]) =>
        String(message).includes('written by another provider') &&
        (data as { exposure?: string } | undefined)?.exposure === 'foreign-2',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toMatchObject({ rowProvider: 'dns-elsewhere', provider: 'stub' });
    warn.mockRestore();
  });
});

describe('the push rides the claim transport (#223)', () => {
  it('pushes what the caller could not otherwise know, and stays quiet about what it asked for', async () => {
    const pushed: Array<{ sessionId: string; text: string }> = [];
    wireExposurePush(fx.exposures, async (sessionId, text) => {
      pushed.push({ sessionId, text });
    });
    const { envId } = await claim();

    // The grant's own answer is in the caller's hand — no push.
    await fx.exposures.expose({ envId, port: 8080, approvedBy: 'g-agent', claimantSessionId: 's1' });
    expect(pushed).toEqual([]);

    // An ending nobody asked for is exactly what a push is for, and the cause
    // travels ON it (#20's recorded why).
    await fx.envs.release(envId);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].sessionId).toBe('s1');
    expect(pushed[0].text).toContain('is revoked (released)');

    // ...and an unexpose the caller performed itself does not push again.
    const second = await claim();
    await fx.exposures.expose({ envId: second.envId, port: 8080, approvedBy: 'g', claimantSessionId: 's1' });
    await fx.exposures.unexpose(second.envId);
    expect(pushed).toHaveLength(1);
  });
});

describe('a second provider slots in without touching the grant model (the dns-readiness claim)', () => {
  it('registers by kind and carries the same grant — every row column but provider/url/detail is identical', async () => {
    // This is the whole promise of the seam: `dns` is a registration, not a
    // rewrite. Nothing below this line is provider-shaped.
    registerExposureProvider('dns-stub', () => new StubProvider('dns-stub'));
    expect(getExposureProviderFactory('dns-stub')).toBeDefined();

    const tailnetish = await runOneGrant(new StubProvider('stub'));
    const dnsish = await runOneGrant(getExposureProviderFactory('dns-stub')!({ installScope: INSTALL }));

    // Everything except the ids, the clocks and the three transport-shaped
    // columns — which is exactly the grant model.
    const model = ({
      exposureId,
      provider,
      url,
      providerDetail,
      envId,
      createdAt,
      revokedAt,
      ...rest
    }: ExposureRow): unknown => rest;
    expect(model(dnsish.live)).toEqual(model(tailnetish.live));
    expect(model(dnsish.ended)).toEqual(model(tailnetish.ended));
    // Only the transport-shaped columns differ — which is what every read
    // surface shows as `provider`, because the perimeter is a provider
    // property and a promotion is therefore a fresh grant.
    expect(dnsish.live.provider).toBe('dns-stub');
    expect(dnsish.live.url).toContain('.dns-stub.invalid/');
    expect(tailnetish.live.url).toContain('.stub.invalid/');
  });

  async function runOneGrant(provider: ExposureProvider): Promise<{ live: ExposureRow; ended: ExposureRow }> {
    const local = await makeFixture(provider as StubProvider);
    try {
      const env = await local.envs.claim({ ownerRef: 'g-agent', stampId: STAMP, lifetime: { mode: 'pinned' } });
      local.runtime.publishService(instanceName({ envId: env.envId, instanceId: env.instanceId! }), {
        service: 'default/backlot',
        address: '10.43.0.9',
        port: 8080,
      });
      const live = await local.exposures.expose({
        envId: env.envId,
        port: 8080,
        name: 'fixed-name',
        approvedBy: 'operator',
      });
      await local.envs.release(env.envId);
      const ended = (await local.exposures.history(env.envId))[0];
      return { live, ended };
    } finally {
      local.exposures.stop();
      await closeDb();
    }
  }
});

describe('the ledger', () => {
  it('keeps every row forever and orders the allocation record live-first, least-recently-revoked next', async () => {
    const first = await claim();
    const second = await claim();
    const a = await fx.exposures.expose({ envId: first.envId, port: 8080, approvedBy: 'operator' });
    await fx.exposures.unexpose(first.envId);
    const b = await fx.exposures.expose({ envId: second.envId, port: 8080, approvedBy: 'operator' });

    const history = await fx.store.allocationHistory('stub');
    expect(history.map((row) => row.name)).toEqual([b.name, a.name]);
    // Rows are never deleted — the audit trail is the point.
    expect(history).toHaveLength(2);
  });

  it('refuses a duplicate live name at the database, not in a handler', async () => {
    const { envId } = await claim();
    const other = await claim();
    await fx.exposures.expose({ envId, port: 8080, name: 'taken', approvedBy: 'operator' });
    await expect(
      fx.exposures.expose({ envId: other.envId, port: 8080, name: 'taken', approvedBy: 'operator' }),
    ).rejects.toThrow();

    // A REVOKED name is re-mintable in v1 (the ruling on question 2): the
    // tailnet URL never carries the name, so nothing points at it.
    await fx.exposures.unexpose(envId);
    expect((await fx.exposures.expose({ envId: other.envId, port: 8080, name: 'taken', approvedBy: 'op' })).name).toBe(
      'taken',
    );
  });
});
