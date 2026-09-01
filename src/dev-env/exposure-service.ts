/**
 * The exposure grant model (C14) — host-side, provider-independent.
 *
 * Everything in this file is about a NAME and a TARGET. The provider is
 * called four times (reportUrl, realize, revoke, heal) and is otherwise not
 * consulted, which is the whole DNS-readiness claim: swapping `tailnet` for
 * `dns` changes what those four calls do and changes nothing here, in the
 * ledger, in the CLI, or in the lifecycle wiring.
 *
 * Two orderings carry the design:
 *
 * - INTENT FIRST. The row lands `pending` before the provider is asked for
 *   anything, so a host that dies mid-realize leaves a row adoption replays —
 *   and a realize that fails takes the grant down with it rather than leaving
 *   a URL advertised that does not serve.
 * - REACHABILITY DIES FIRST. Revocation is wired into the env lifecycle
 *   through `onBeforeEnvEnd`, which runs BEFORE instance teardown on every
 *   ending path — release, TTL reap, bound-owner release, terminal failure.
 *   An exposed port dies with its env, unasked. Supersession (D21) is
 *   deliberately not an ending: an instance replaced under a LIVE env parks
 *   the exposure, and the provider's resolve-per-connection simply refuses
 *   until the successor's service exists.
 */
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

import type { DbDriver } from '../db/driver.js';
import { log } from '../log.js';

import { deliverClaimPushToSession, type ClaimPushDeliver } from './claim-notify.js';
import {
  EnvExposureStore,
  assertExposureName,
  defaultExposureName,
  exposureIsLive,
  type ExposureRevokeCause,
  type ExposureRow,
} from './exposure.js';
import type { ExposureBinding, ExposureDialer, ExposureGrant, ExposureProvider } from './exposure-provider.js';
import type { DevEnvService } from './service.js';
import type { ExposureTargetResolution } from './types.js';

export interface ExposeRequest {
  envId: string;
  port: number;
  /** Omitted = resolved at grant from the port alone; two qualifying is a refusal. */
  service?: string;
  /** Omitted = derived from the target; either way it is a DNS label. */
  name?: string;
  /** Who signed: the approving chain's caller — 'operator' for a host caller. */
  approvedBy: string;
  /** Told when an UNASKED transition happens (#223's transport); null = nobody waits. */
  claimantSessionId?: string | null;
}

export type ExposureEvent =
  /** `awaited` = the grant call is returning this row to its caller, so nobody needs telling. */
  | { kind: 'exposure-live'; row: ExposureRow; awaited: boolean }
  | { kind: 'exposure-revoked'; row: ExposureRow; awaited: boolean };

/**
 * Does the target speak TLS on this port? Asked ONCE, at grant, against the
 * address the driver has just resolved — and the answer is then frozen into
 * the provider's own column, exactly as the resolved service name is frozen
 * into the row.
 *
 * WHY A PROBE, WHEN THIS USED TO BE A FLAG. `ncl envs expose --tls` declared
 * it, and the justification written here was that a probe would have to run at
 * grant AND at every reassert, because a target that changed scheme between
 * them would leave a live row dialling the wrong one. That argument does not
 * survive being read twice: a DECLARED value goes wrong after exactly the same
 * change, at exactly the same moment, because it is frozen at exactly the same
 * moment. The declaration bought nothing the probe does not, and cost every
 * caller a flag to remember — one whose failure mode is silent (an empty 502
 * through the proxy while the target answers perfectly when dialled directly),
 * so the caller who forgets it cannot read the answer off the symptom either.
 *
 * REFUSE, NEVER GUESS. A target that will not answer at all is not evidence of
 * plaintext, it is the absence of evidence. Writing `false` for a TLS target
 * that happened to be restarting mints an exposure that answers an empty 502
 * for the rest of its life — the exact failure this replaces, with nobody left
 * to blame it on. So the probe REFUSES the grant when the target does not
 * answer, and the caller retries when it is up. A plaintext target is entirely
 * legitimate; it just has to say so.
 *
 * Throwing is the refusal; the boolean is the recorded answer.
 */
export type ExposureTlsProbe = (target: ExposureTargetResolution) => Promise<boolean>;

export interface EnvExposureServiceConfig {
  db: DbDriver;
  envs: DevEnvService;
  provider: ExposureProvider;
  /** Injectable for tests; production heals on the same cadence the reaper runs. */
  healIntervalMs?: number;
  /**
   * Injectable for tests; production opens real sockets to the resolved
   * target. A fixture whose addresses nothing serves must pass its own, or
   * every grant in it refuses — correctly, because a target that answers
   * nothing is exactly what this refuses.
   */
  probeBackendTls?: ExposureTlsProbe;
}

const DEFAULT_HEAL_INTERVAL_MS = 60_000;

/**
 * Per leg, and the probe is at most two legs. Long enough for a cold ClusterIP
 * on the same box, short enough that a grant never looks hung to the agent
 * waiting on its answer.
 */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * The production probe: two connections, in this order, because they answer
 * two different questions.
 *
 * 1. PLAIN TCP — does anything answer here at all? A refusal, a reset or
 *    silence is "the target is not up", which is the one answer that must
 *    never be rounded to plaintext.
 * 2. A TLS ClientHello on a FRESH connection — a handshake that completes is
 *    the target saying TLS in the only way that cannot be misread, and an
 *    SSL-layer error is it answering in a language that is not TLS. Anything
 *    else refuses the grant: see `handshakesTls` for why "an error happened"
 *    is not the same question as "which error".
 *
 * The certificate is not the question and could not be answered anyway — see
 * `TAILNET_BACKEND_TLS` for why this hop is unverifiable by construction. And
 * no SNI is sent, because the address is an IP: a target that refused to
 * complete a handshake WITHOUT a server name would read as plaintext here.
 * Nothing does today (a child's facade serves one certificate on the port),
 * and the alternative — sending the driver's `namespace/service` identity as a
 * server name — would be inventing a hostname the target never claimed.
 */
export const socketTlsProbe: ExposureTlsProbe = async (target) => {
  await assertTargetAnswers(target);
  return handshakesTls(target);
};

/**
 * Step 1: proof that something is listening, or the reason nothing is.
 *
 * `on('error')`, never `once` — see `handshakesTls`: a socket that raises a
 * second error after this promise has settled has no listener left under
 * `once`, and an unhandled `error` event is an uncaught exception, which this
 * host answers with `process.exit(1)`. A probe must never be able to take the
 * host down; settling is idempotent, so absorbing the extra event costs
 * nothing.
 */
function assertTargetAnswers(target: ExposureTargetResolution): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(target.port, target.address);
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(new Error(`no answer within ${PROBE_TIMEOUT_MS}ms`)));
    socket.on('connect', () => finish());
    socket.on('error', (error) => finish(error));
  });
}

/**
 * Step 2: TLS or not — and the verdict is read off WHICH failure, never off
 * the fact that one happened.
 *
 * An SSL-layer error is an answer: the target received the ClientHello and
 * replied in something that is not TLS. A CONNECTION error is the absence of
 * one — the target is no longer there. Step 1 proved it was there a connection
 * ago, so a connection error HERE is precisely the "TLS but briefly down"
 * case, arriving in the one-connection-wide window this two-leg probe opens,
 * and reading it as plaintext would mint the exposure that answers an empty
 * 502 for the rest of its life. That is the failure the whole refusal exists
 * to prevent, so it refuses rather than resolving `false`, and the caller
 * retries once the target is back.
 *
 * MEASURED against one listener per line (node v22.22.0, ClientHello sent with
 * `rejectUnauthorized: false`); the code is what the classifier keys on:
 *
 *   https server, self-signed        secureConnect                    → TLS
 *   https server, requestCert        secureConnect                    → TLS
 *   node http server (answers 400)   ERR_SSL_PACKET_LENGTH_TOO_LONG   → plaintext
 *   plaintext line protocol          ERR_SSL_WRONG_VERSION_NUMBER     → plaintext
 *   nothing listening any more       ECONNREFUSED                     → REFUSE
 *   accepts, then RST                ECONNRESET                       → REFUSE
 *   accepts, then clean FIN          ECONNRESET                       → REFUSE
 *   accepts, then says nothing       (no event, the timeout below)    → REFUSE
 *   sends a TLS alert, no handshake  ERR_SSL_..._ALERT_...            → REFUSE
 *
 * The hang-up shapes refuse for the same reason the timeout does — a target
 * that drops the bytes it cannot parse has said nothing about its scheme — and
 * losing them costs nothing real: this provider proxies HTTP, so a target that
 * answers neither HTTP nor TLS is not one `tailscale serve` could carry
 * whichever way we guessed it.
 *
 * THE ALERT ROW IS THE SUBTLE ONE. An alert is a TLS record, so the target
 * demonstrably speaks TLS — recording plaintext for it is the empty-502 bug
 * with proof in hand. But an alert is also the target refusing THIS handshake,
 * and the proxy's hop is this handshake: `tailscale serve` dials
 * `https+insecure://127.0.0.1:<port>`, an IP literal, so it sends no SNI
 * either and gets the same alert. Recording `true` would buy a live URL that
 * cannot be served. So an alert refuses, with its code in the message, and the
 * fix is at the target.
 *
 * Every listener is `on`, not `once`: `settled` already makes a second event a
 * no-op, and under `once` a socket that raised a second `error` after this one
 * settled would have none left — an unhandled `error` event is an uncaught
 * exception, which this host answers with `process.exit(1)` (`log.ts`), taking
 * every other env's relay with it. Insurance rather than a fixed crash: no
 * shape tried here (RST after garbage, alert then RST, half a record then RST)
 * raised a second error once `finish` had destroyed the socket.
 */
function handshakesTls(target: ExposureTargetResolution): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: target.address, port: target.port, rejectUnauthorized: false });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (answer: boolean | undefined, error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(answer === true);
    };
    // A target that answers TCP and then neither completes a handshake nor
    // refuses one has told us nothing, and "nothing" must not become
    // plaintext. Refusing here costs a retry; guessing costs a live exposure
    // that 502s for as long as the grant lasts.
    timer = setTimeout(
      () =>
        finish(
          undefined,
          new Error(`answered TCP but neither completed nor refused a TLS handshake within ${PROBE_TIMEOUT_MS}ms`),
        ),
      PROBE_TIMEOUT_MS,
    );
    timer.unref?.();
    socket.on('secureConnect', () => finish(true));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      const verdict = classifyHandshakeFailure(error);
      if (verdict === 'plaintext') return finish(false);
      const why =
        verdict === 'alert'
          ? 'answered a TLS alert instead of completing the handshake — it speaks TLS but refused these ' +
            'parameters, and the proxy dials it exactly the same way, so the grant is refused rather than ' +
            'recorded as either scheme'
          : 'answered TCP on the previous connection and then dropped this one without answering it — ' +
            'the target went away mid-probe, which is not evidence of plaintext';
      finish(undefined, new Error(`${why} (${error.code ?? String(error.message)})`, { cause: error }));
    });
    // Belt and braces: every hang-up measured above raised ECONNRESET first,
    // so nothing reaches here today — and if a shape ever does, it is a close
    // that carried no evidence either way, which is a refusal like the rest.
    socket.on('close', () =>
      finish(undefined, new Error('answered TCP, then closed the connection without answering the TLS handshake')),
    );
  });
}

/**
 * What a failed handshake proves about the target, from the error code alone:
 *
 * - `plaintext` — the record layer got bytes it could not read as TLS, which
 *   is what a plaintext server replying to a ClientHello looks like. `EPROTO`
 *   is the same verdict from the older node/OpenSSL pairings that surfaced
 *   these as a POSIX code; it stays because the classification, not one node
 *   version, is what this rests on.
 * - `alert` — a TLS record arrived, saying no. Every alert code node emits
 *   carries `_ALERT_` (measured: `ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE`,
 *   `ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION`), and they are `ERR_SSL_*` too, so
 *   this test has to come FIRST or every alert would read as plaintext.
 * - `gone` — anything else is a connection-level failure: no answer at all,
 *   from a target step 1 saw answer a moment ago.
 */
function classifyHandshakeFailure(error: NodeJS.ErrnoException): 'plaintext' | 'alert' | 'gone' {
  const code = error.code ?? '';
  if (code.includes('_ALERT_')) return 'alert';
  if (code.startsWith('ERR_SSL_') || code === 'EPROTO') return 'plaintext';
  return 'gone';
}

export class EnvExposureService {
  private store: EnvExposureStore;
  private envs: DevEnvService;
  private provider: ExposureProvider;
  private healIntervalMs: number;
  private probeBackendTls: ExposureTlsProbe;
  private listeners = new Set<(event: ExposureEvent) => void>();
  private unwire: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Exposure ids already reported as another provider's — see `carries`. */
  private foreignSeen = new Set<string>();

  constructor(config: EnvExposureServiceConfig) {
    this.store = new EnvExposureStore(config.db);
    this.envs = config.envs;
    this.provider = config.provider;
    this.healIntervalMs = config.healIntervalMs ?? DEFAULT_HEAL_INTERVAL_MS;
    this.probeBackendTls = config.probeBackendTls ?? socketTlsProbe;
  }

  get providerKind(): string {
    return this.provider.kind;
  }

  onEvent(cb: (event: ExposureEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Wire revocation into the env lifetime. Called once at construction time
   * by the host wiring; returns the unwire for tests.
   *
   * `onBeforeEnvEnd` is the ordering that matters — it runs before teardown,
   * awaited. The ready event is the succession re-arm: the same name, the
   * same URL, the same row, no fresh approval (the approved surface is name +
   * target; the instance was never part of it).
   */
  wireLifecycle(): () => void {
    this.unwire.push(
      this.envs.onBeforeEnvEnd(async (envId, ending) => {
        await this.revokeForEnv(envId, ending === 'failed' ? 'env-failed' : 'released');
      }),
    );
    this.unwire.push(
      this.envs.onEvent((event) => {
        if (event.kind !== 'env-ready') return;
        void this.healEnv(event.env.envId).catch((error) => {
          log.warn('Dev-env exposure: re-arm after env-ready failed', {
            envId: event.env.envId,
            error: String(error),
          });
        });
      }),
    );
    return () => {
      for (const off of this.unwire.splice(0)) off();
    };
  }

  /**
   * The grant. By the time this runs an agent caller's frame has been held for
   * the admin chain and replayed on approval, so no exposure exists that an
   * admin did not sign for — the same discipline `stamps create` proved, and
   * the row this writes is written by the approved replay.
   *
   * SAY WHAT THE SIGNATURE COVERS, because it is not everything this method
   * decides. The admin card is rendered from the COMMAND FRAME — the env id,
   * the port, and `--service`/`--name` when the caller passed them. The
   * resolved service, the provider, the external port and the URL are
   * computed HERE, on the replay, after the signature. So the gate guarantees
   * "an admin approved opening port N of env E to a browser"; it does not put
   * the concrete service or the literal URL in front of the admin before they
   * sign. Closing that gap needs a pre-approval prepare() hook in dispatch
   * (the card would have to be rendered from a dry run of this method) —
   * deliberately NOT built here, and an open question for Gavriel.
   */
  async expose(request: ExposeRequest): Promise<ExposureRow> {
    const env = await this.envs.status(request.envId);
    if (env.state !== 'active') {
      throw new Error(
        `env ${request.envId} is ${env.state} — only an active env can be exposed ` +
          '(a claim still provisioning has nothing to point at yet)',
      );
    }
    if (!Number.isInteger(request.port) || request.port <= 0 || request.port > 65535) {
      throw new Error(`--port must be a TCP port number, got "${request.port}"`);
    }
    // No per-env guard: an env may carry as many names as it has things worth
    // reaching, and the second grant used to die here on "one exposure per env
    // in v1" — a claimed child that has to answer as its chat UI AND as its
    // governance dashboard was refused the second one. Uniqueness lives on the
    // NAME now, where the ledger's partial index already enforces it.
    //
    // Ambiguity is a GRANT-time question: with the port alone the driver finds
    // the one qualifying service or refuses to guess, and the resolved name
    // freezes into the row so every later dial resolves that name rather than
    // scanning ports — and so the audit trail, the read surfaces and the
    // grant's own answer all name one concrete service. (The admin card does
    // not; see the note on this method.)
    const resolved = await this.envs.resolveExposureTarget(request.envId, {
      service: request.service,
      port: request.port,
    });
    if (resolved === undefined) {
      throw new Error(
        `this deployment's dev-env driver does not resolve exposure targets — ` +
          'exposure needs a driver that can answer "what serves this port, right now"',
      );
    }
    if (!resolved) {
      throw new Error(
        request.service
          ? `no service '${request.service}' serving port ${request.port} in env ${request.envId} right now`
          : `nothing in env ${request.envId} serves port ${request.port} right now — ` +
            'check the child (ncl envs get) or name the service with --service',
      );
    }
    const name = assertExposureName(
      request.name ?? defaultExposureName(request.envId, resolved.service, request.port),
    );
    const rowFields = { name, envId: request.envId, service: resolved.service, port: request.port };
    // The target's scheme, asked ONCE, here, against the address that was just
    // resolved — see `ExposureTlsProbe` for why this is probed rather than
    // declared, and why a target that will not answer refuses the grant.
    let backendTls: boolean;
    try {
      backendTls = await this.probeBackendTls(resolved);
    } catch (error) {
      throw new Error(
        `env ${request.envId}: ${resolved.service}:${request.port} did not answer at ${resolved.address} ` +
          `(${String(error)}) — the grant is refused rather than guessing its scheme, because recording ` +
          '"plaintext" for a target that was only briefly down mints an exposure that answers an empty 502 ' +
          `for good. Check the child (ncl envs get ${request.envId}) and expose again.`,
        { cause: error },
      );
    }
    // `backendTls` reaches the PROVIDER and stops there. It is not a row column:
    // whether a target speaks TLS is how this provider dials, and the grant
    // model does not read inside `providerDetail`. That also means the ledger
    // needs no migration — an old row simply carries no such key, and the
    // provider reads its absence as the plaintext it was.
    const draft = { ...rowFields, backendTls };
    // The URL is stated BEFORE the row exists and never changes afterwards.
    // A provider that cannot serve this box refuses HERE, with its reason.
    const { url, detail } = this.provider.reportUrl(draft, await this.store.allocationHistory(this.provider.kind));
    const row = await this.insertGrant({
      exposureId: `expo-${randomUUID()}`,
      ...rowFields,
      provider: this.provider.kind,
      providerDetail: detail,
      url,
      ownerRef: env.ownerRef,
      approvedBy: request.approvedBy,
      claimantSessionId: request.claimantSessionId ?? null,
    });
    return this.realize(row, true);
  }

  /** Every live-or-pending grant, or one env's. Reads are open; rows are the audit trail. */
  async list(filter: { envId?: string } = {}): Promise<ExposureRow[]> {
    if (!filter.envId) return this.store.listLive();
    return this.liveForEnv(filter.envId);
  }

  /** This env's live-or-pending grants, oldest first — plural, and often empty. */
  async liveForEnv(envId: string): Promise<ExposureRow[]> {
    return this.store.liveForEnv(envId);
  }

  /** The whole audit trail for one env — ended rows included, forever. */
  async history(envId: string): Promise<ExposureRow[]> {
    return this.store.listForEnv(envId);
  }

  /**
   * `ncl envs unexpose` — closing a hole needs no ceremony (the deliberate
   * asymmetry). With no name it closes EVERY hole this env has: closing is the
   * fail-safe direction, and an operator who has just read two `exposed:` lines
   * and typed `unexpose <env>` means both of them. A name closes exactly that
   * one, which is the only way to keep the other live now that an env may carry
   * several.
   *
   * The name is looked up WITHIN the env, never globally: the caller has been
   * checked against this env id and nothing else, so a name that belongs to
   * another env's grant must read as "not here", not as a hole to close.
   */
  async unexpose(envId: string, name?: string): Promise<ExposureRow[]> {
    if (name === undefined) return this.revokeForEnv(envId, 'requested');
    const row = (await this.store.liveForEnv(envId)).find((candidate) => candidate.name === name);
    if (!row) return [];
    const ended = await this.revokeRow(row, 'requested');
    return ended ? [ended] : [];
  }

  /**
   * Revoke everything this env exposes — ALL of it, because an ending is an
   * ending: the env is going and every name pointed at it goes with it.
   * Idempotent: an env with no live grant answers an empty list, because the
   * reaper, an explicit unexpose and a crashing instance all race and every
   * one of them must win.
   *
   * Every row is attempted before anything is thrown. A transport that will
   * not come down must not leave its NEIGHBOURS open — the same rule
   * `revokeForStamp` follows per row, and the reason it matters more here is
   * that this runs from `onBeforeEnvEnd`, where the caller logs and continues
   * the teardown. Stopping at the first failure would tear the env down with
   * its other holes still listening. The first failure is still raised, after
   * the loop, so the ending is never silently partial.
   */
  async revokeForEnv(envId: string, cause: ExposureRevokeCause): Promise<ExposureRow[]> {
    const rows = await this.store.liveForEnv(envId);
    const ended: ExposureRow[] = [];
    let failure: unknown;
    for (const row of rows) {
      try {
        const done = await this.revokeRow(row, cause);
        if (done) ended.push(done);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
    return ended;
  }

  /**
   * Retiring a stamp closes the holes opened onto it. Retire leaves live envs
   * running (that is the stamps contract, unchanged) — but an exposure is a
   * hole in the perimeter approved against a named definition, and withdrawing
   * the definition withdraws the approval's subject. The env keeps working
   * from inside; only its reachability from a browser ends.
   */
  async revokeForStamp(stampId: string, cause: ExposureRevokeCause = 'stamp-retired'): Promise<ExposureRow[]> {
    const live = await this.store.listLive();
    if (live.length === 0) return [];
    const envs = new Map((await this.envs.list({ live: true })).map((env) => [env.envId, env]));
    const revoked: ExposureRow[] = [];
    for (const row of live) {
      if (envs.get(row.envId)?.stampId !== stampId) continue;
      try {
        const ended = await this.revokeRow(row, cause);
        if (ended) revoked.push(ended);
      } catch (error) {
        // Per row, because one hole that will not close must not leave the
        // rest open — and NOTHING re-reads stamp state: heal re-asserts live
        // grants, it never revisits which stamp they were granted against.
        //
        // WHICH HALF failed decides the remediation, so the row is re-read
        // rather than guessed at. `revokeRow` ends the LEDGER first: a row
        // still live here means that write did not land and `ncl envs
        // unexpose` is a real retry. An ENDED row means only the transport
        // survived — and unexpose would answer "exposes nothing", because it
        // reads the live row this ending already removed. What closes THAT is
        // the provider's own heal sweep, which sees a transport no live
        // binding names and closes it if it can attribute it; a line that
        // keeps repeating is one the provider cannot, and it wants a hand at
        // the transport itself.
        const after = await this.store.get(row.exposureId).catch(() => undefined);
        const ledgerEnded = after !== undefined && !exposureIsLive(after);
        log.warn('Dev-env exposure: could not close an exposure onto a retired stamp', {
          exposure: row.name,
          envId: row.envId,
          stamp: stampId,
          ledger: after?.state ?? 'unreadable',
          fix: ledgerEnded
            ? `the grant is ended; its transport is a stray for the ${this.provider.kind} provider's heal to ` +
              'close on its next tick — if this line repeats, close it at the transport by hand'
            : `ncl envs unexpose ${row.envId}`,
          error: String(error),
        });
      }
    }
    return revoked;
  }

  /**
   * Reconcile provider state against the live rows, both ways: replay grants
   * whose realize never finished (a host death mid-grant), then hand the
   * provider every live binding so it can re-assert what is missing and close
   * strays it can attribute. Runs at adopt and on the tick.
   *
   * Rows this install's provider did not write are skipped, not adapted (see
   * `carries`).
   */
  async heal(): Promise<void> {
    const rows = (await this.store.listLive()).filter((row) => this.carries(row, 'heal'));
    const live: ExposureRow[] = [];
    for (const row of rows) {
      if (row.state !== 'pending') {
        live.push(row);
        continue;
      }
      // Approved, never carried: the grant is a fact in the ledger, so the
      // replay is a realize, not a new approval.
      try {
        live.push(await this.realize(row, false));
      } catch (error) {
        log.warn('Dev-env exposure: pending grant could not be realized at heal', {
          exposure: row.name,
          envId: row.envId,
          error: String(error),
        });
      }
    }
    await this.provider.heal(live.map((row) => this.bindingFor(row)));
  }

  start(signal?: AbortSignal): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.heal().catch((error) => log.warn('Dev-env exposure: heal tick failed', { error: String(error) }));
    }, this.healIntervalMs);
    this.timer.unref?.();
    signal?.addEventListener('abort', () => this.stop());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.provider.stop?.();
  }

  // ---------- internals ----------

  /**
   * pending → live, or the grant dies with its reason. `awaited` says whether
   * the caller of this transition is holding the answer — a grant returns the
   * row to the requester, so nobody needs a push; a heal's replay does.
   */
  private async realize(row: ExposureRow, awaited: boolean): Promise<ExposureRow> {
    try {
      const { url } = await this.provider.realize(this.bindingFor(row));
      const live = await this.store.markLive(row.exposureId, url);
      if (live.state !== 'live') {
        // An ending won the race while the provider was working — release, a
        // reap, an unexpose. The ledger keeps THAT truth (markLive refuses a
        // terminal row), and the transport this call just brought up must not
        // outlive it: the catch below tears it down with the same cleanup a
        // failed realize gets.
        throw new Error(
          `exposure '${row.name}' was revoked (${live.revokeCause ?? 'unknown'}) while it was being realized`,
        );
      }
      log.info('Dev-env exposure: live', {
        exposure: live.name,
        envId: live.envId,
        service: live.service,
        port: live.port,
        provider: live.provider,
        url: live.url,
      });
      this.emit({ kind: 'exposure-live', row: live, awaited });
      return live;
    } catch (error) {
      // No URL is ever left advertised that does not serve: the grant goes
      // terminal with the provider's own reason, and the name and whatever
      // the provider allocated are free again.
      const failed = (await this.store.revoke(row.exposureId, 'realize-failed')) ?? row;
      await this.provider.revoke(grantOf(failed)).catch((cleanup) => {
        log.warn('Dev-env exposure: cleanup after a failed realize also failed', {
          exposure: failed.name,
          error: String(cleanup),
        });
      });
      log.warn('Dev-env exposure: grant failed to realize', {
        exposure: failed.name,
        envId: failed.envId,
        provider: failed.provider,
        error: String(error),
      });
      // Only OUR ending is announced here — revokeRow's rule, for the same
      // reason: when a release or an unexpose won the race it has already
      // told whoever was waiting, and a second push would be noise.
      if (failed.revokeCause === 'realize-failed') {
        this.emit({ kind: 'exposure-revoked', row: failed, awaited });
      }
      throw error;
    }
  }

  private async revokeRow(row: ExposureRow, cause: ExposureRevokeCause): Promise<ExposureRow | undefined> {
    const ended = await this.store.revoke(row.exposureId, cause);
    // Someone else's ending won the race and the ledger keeps THEIR truth;
    // the transport is torn down either way — both revokes must win. The
    // LEDGER ending is unconditional; only the transport call needs the row
    // to be one this provider wrote (see `carries`), because handing a dns
    // row's detail to the tailnet provider is a refusal at best and the wrong
    // port closed at worst.
    if (this.carries(row, 'revoke')) await this.provider.revoke(grantOf(row));
    log.info('Dev-env exposure: revoked', {
      exposure: row.name,
      envId: row.envId,
      provider: row.provider,
      cause: ended?.revokeCause ?? cause,
    });
    if (ended && ended.revokeCause === cause) {
      // A caller that asked for this ending is not told about it twice.
      this.emit({ kind: 'exposure-revoked', row: ended, awaited: cause === 'requested' });
    }
    return ended;
  }

  /**
   * The env-ready re-arm, for ONE env — but the provider is still handed the
   * COMPLETE live set, because that is the only thing `heal(bindings)` may be
   * called with. The argument is what the provider attributes strays against:
   * a subset says "these are the only live grants", and a provider entitled to
   * close what it can attribute and does not see would take every OTHER env's
   * exposure down. So this decides WHETHER to reconcile — one env's readiness
   * is not news for a box with no grant on it — and `heal` decides with what.
   */
  private async healEnv(envId: string): Promise<void> {
    const rows = await this.store.liveForEnv(envId);
    if (!rows.some((row) => this.carries(row, 'heal'))) return;
    await this.heal();
  }

  /**
   * The ledger's own refusal, said in a sentence.
   *
   * The partial unique index stays the guard — two approved replays can land
   * in the same tick and only the database can settle that race — and this
   * only translates its verdict. It asks the LEDGER who holds the name rather
   * than matching the driver's error text, because SQLite and PostgreSQL word
   * a unique violation differently and a text match would quietly stop
   * translating on the backend nobody runs locally.
   *
   * It earns its place now that an env may carry several names: the derived
   * name is `<service>-<env-short>`, so exposing a SECOND PORT of the same
   * service is the ordinary way to meet this, and `UNIQUE constraint failed:
   * env_exposures.name` is not something an agent can act on.
   */
  private async insertGrant(row: Parameters<EnvExposureStore['insertPending']>[0]): Promise<ExposureRow> {
    try {
      return await this.store.insertPending(row);
    } catch (error) {
      const holder = await this.store.liveForName(row.name).catch(() => undefined);
      if (!holder) throw error;
      throw new Error(
        `exposure name '${row.name}' is already live on env ${holder.envId} (${holder.url}) — a name is unique ` +
          'while it is live. Give this one its own with --name <dns-label>, or close the other with: ' +
          `ncl envs unexpose ${holder.envId} --name ${holder.name}`,
        { cause: error },
      );
    }
  }

  /**
   * Is this row one THIS install's provider wrote? A grant records the kind
   * that minted it, and `provider_detail` is that provider's private column —
   * so after an operator switches `NANOCLAW_DEV_ENV_EXPOSURE_PROVIDER` the
   * older rows are not this provider's to realize, re-assert or tear down.
   * The ledger still ends them (the row is the audit trail either way); the
   * TRANSPORT is left to the provider that owns it, which is the same
   * not-our-territory posture the tailnet provider takes for a port outside
   * its recorded range. A row that never gets its provider back is closed by
   * hand, and this line in the log is where an operator learns it exists.
   *
   * ONCE PER ROW, not once per tick. Heal runs this over every live row every
   * 60s, and a foreign row is a state that does not change until somebody
   * acts on it — a line a minute, per row, forever, would bury the log it is
   * supposed to be read from. The seen-set is process state beside the
   * provider it is about, so the switch that made these rows foreign (a new
   * `NANOCLAW_DEV_ENV_EXPOSURE_PROVIDER`, which is a restart) says it again.
   */
  private carries(row: ExposureRow, operation: string): boolean {
    if (row.provider === this.provider.kind) return true;
    if (!this.foreignSeen.has(row.exposureId)) {
      this.foreignSeen.add(row.exposureId);
      log.warn('Dev-env exposure: row was written by another provider; leaving its transport alone', {
        exposure: row.name,
        envId: row.envId,
        rowProvider: row.provider,
        provider: this.provider.kind,
        // The operation that first met it — the later ones are the same news.
        operation,
      });
    }
    return false;
  }

  /**
   * The pair every provider call works from: the grant, and the dial that
   * answers where its target is NOW. The dialer closes over the FROZEN
   * service name and asks the driver per connection — a `null` (renamed away,
   * deleted, no live instance) is a refused connection, never a fallback.
   */
  private bindingFor(row: ExposureRow): ExposureBinding {
    const dial: ExposureDialer = async () =>
      (await this.envs.resolveExposureTarget(row.envId, { service: row.service, port: row.port })) ?? null;
    return { grant: grantOf(row), dial };
  }

  private emit(event: ExposureEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A subscriber's bug must not break revocation.
      }
    }
  }
}

/** The ledger row, as the provider sees it — no state, no audit, no ownership. */
export function grantOf(row: ExposureRow): ExposureGrant {
  return {
    exposureId: row.exposureId,
    name: row.name,
    envId: row.envId,
    service: row.service,
    port: row.port,
    url: row.url,
    providerDetail: row.providerDetail,
  };
}

/**
 * Exposure transitions reach the requesting session on the SAME transport
 * claim readiness rides (#223 / D18): one notification mechanism, three
 * subscribers now. Only UNAWAITED transitions push — a grant's own answer is
 * already in the caller's hand, and a second message for it would be the
 * noise the claim push was careful not to make. What is left is exactly what
 * an agent could not otherwise know: a grant realized by a restart's heal,
 * and a revocation nobody asked for (the env ended, the stamp was retired,
 * the transport could not be brought up).
 */
export function wireExposurePush(
  service: EnvExposureService,
  deliver: ClaimPushDeliver = deliverClaimPushToSession,
): () => void {
  return service.onEvent((event) => {
    if (event.awaited || !event.row.claimantSessionId) return;
    void deliver(event.row.claimantSessionId, exposurePushText(event)).catch((error) => {
      log.warn('Dev-env exposure: push not delivered', { exposure: event.row.name, error: String(error) });
    });
  });
}

function exposurePushText(event: ExposureEvent): string {
  const { row } = event;
  if (event.kind === 'exposure-live') {
    return `Exposure '${row.name}' is live: ${row.url} → ${row.service}:${row.port} (env ${row.envId}).`;
  }
  // The reason travels ON the push (#20's recorded why), same rule as the
  // claim-failure and placement pushes.
  return (
    `Exposure '${row.name}' is revoked (${row.revokeCause ?? 'unknown'}) — ${row.url} no longer serves env ` +
    `${row.envId}. That URL may later be reissued to another exposure.`
  );
}
