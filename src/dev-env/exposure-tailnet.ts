/**
 * The tailnet exposure provider (C14, v1) — one HTTPS port per exposure on
 * the box's existing tailnet name.
 *
 *   tailscale serve --bg --https=<extPort> http://127.0.0.1:<extPort>
 *   → https://<box>.<tailnet>.ts.net:<extPort>/
 *
 * The backend is ALWAYS loopback. A per-grant relay inside the host process
 * listens on `127.0.0.1:<extPort>` — free, because serve terminates inside
 * tailscaled and never binds a host socket, and one number naming both halves
 * is what lets realize rebuild a relay from the ledger row alone — and dials,
 * PER CONNECTION, the address the driver resolves NOW. The alternative
 * (writing the ClusterIP into serve config with a re-resolve tick) leaves
 * every tick-width as a window where a re-minted Service aims an approved URL
 * at an address the cluster may already have reissued into another group's
 * env. Rejected: no address is ever written down here, and a MISS refuses the
 * connection rather than dialing a memory.
 *
 * HTTPS only (the ruling on open question 3): no `--tcp` path exists in this
 * file. A raw-TCP capability is a per-provider decision a later provider may
 * never want, and adding it later costs nothing that adding it now would save.
 *
 * WHAT THIS BOX MUST HAVE, and what happens when it does not. Serve on
 * `--https` needs MagicDNS plus the HTTPS-certificates feature enabled on the
 * CUSTOMER'S tailnet (a tailnet-admin console action no host step can
 * perform), and the first `--https` serve triggers ACME issuance, which needs
 * Let's Encrypt egress from the box. `tailscale serve` itself needs root or a
 * tailscale-operator grant to the host user (the recommended privilege seam:
 * `sudo tailscale set --operator=<host user>`, recorded at wire-host like the
 * TTL knobs). None of that is this platform's to arrange, so none of it is
 * assumed: the verify verdict and the port range are RECORDED as host
 * configuration, and where they are missing every grant refuses loudly with
 * the named reason. A URL that cannot serve is never minted, and no refusal
 * is ever silent.
 */
import net from 'node:net';

import { realCli, type Cli } from '../drivers/cli.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

import {
  exposureRefusal,
  registerExposureProvider,
  type ExposureBinding,
  type ExposureDialer,
  type ExposureDraft,
  type ExposureGrant,
  type ExposureProvider,
} from './exposure-provider.js';
import type { ExposureRow } from './exposure.js';

export const TAILNET_PROVIDER_KIND = 'tailnet';

/** The provider's private column key — nothing in the grant model reads it. */
export const TAILNET_EXT_PORT = 'extPort';

/**
 * Whether the TARGET speaks TLS, recorded on the grant so every later reassert
 * dials it the same way. The grant model probes the target once, at grant, and
 * hands the answer over on the draft (see `ExposureTlsProbe`); this key is
 * where it is frozen.
 *
 * `tailscale serve` must be told the backend's scheme; it does not discover it.
 * Pointed at `http://` when the target serves TLS, every request through the
 * exposure answers **502 with an empty body** — no handshake error, no mention
 * of a scheme, and the target itself perfectly healthy when probed directly.
 *
 * `https+insecure` rather than `https`, and the "insecure" is precise rather
 * than lazy: the relay listens on loopback and dials the target's ClusterIP,
 * while the target's certificate names its Service DNS. Verification could
 * therefore never succeed on this hop no matter whose CA is trusted, and the
 * hop itself is inside the box. The consumer's TLS — the half that is actually
 * exposed — is terminated by tailscaled with a real Let's Encrypt certificate
 * and is untouched by this.
 */
export const TAILNET_BACKEND_TLS = 'backendTls';

const HOST_ENV_KEY = 'NANOCLAW_DEV_ENV_EXPOSURE_TAILNET_HOST';
const PORTS_ENV_KEY = 'NANOCLAW_DEV_ENV_EXPOSURE_TAILNET_PORTS';
const HTTPS_ENV_KEY = 'NANOCLAW_DEV_ENV_EXPOSURE_TAILNET_HTTPS';

/** The default per-install range; a second install on the same box gets a disjoint one at wire-host. */
export const DEFAULT_TAILNET_PORT_RANGE = { from: 20000, to: 20099 };

/** process.env first, then `.env` — the precedence every dev-env knob resolves under. */
function envValue(name: string, env: NodeJS.ProcessEnv): string | undefined {
  return env[name]?.trim() || readEnvFile([name])[name]?.trim() || undefined;
}

export interface TailnetPortRange {
  from: number;
  to: number;
}

export interface TailnetProviderConfig {
  /** The box's MagicDNS name, e.g. `dev-box.tail1234.ts.net`. Recorded at wire-host. */
  host?: string;
  /** This install's reserved range. Recorded at wire-host beside the verify verdict. */
  range?: TailnetPortRange;
  /**
   * The wire-host VERIFY verdict for tailnet HTTPS. Only `verified` opens
   * grants: on a tailnet without MagicDNS + HTTPS certificates the first
   * `--https` serve fails at ACME, and discovering that at grant time (after
   * an approval) is the intent-first ordering violated. On the POC the cert
   * path is proven only because serve already fronts governance — "for free"
   * is that box's state, not a tailnet given.
   */
  httpsVerified?: boolean;
  /** Injectable for tests; production spawns the real `tailscale` binary. */
  cli?: Cli;
  /** Injectable for tests; production listens on real loopback sockets. */
  relayFactory?: RelayFactory;
}

export function tailnetConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TailnetProviderConfig {
  const verdict = envValue(HTTPS_ENV_KEY, env)?.toLowerCase();
  return {
    host: envValue(HOST_ENV_KEY, env),
    range: parsePortRange(envValue(PORTS_ENV_KEY, env)),
    httpsVerified: verdict === 'verified' || verdict === 'true' || verdict === 'yes',
  };
}

/** `20000-20099`. A malformed value is a boot-time config error, not a per-grant mystery. */
export function parsePortRange(raw: string | undefined): TailnetPortRange | undefined {
  if (!raw) return undefined;
  const match = /^(\d{2,5})-(\d{2,5})$/.exec(raw.trim());
  if (!match) throw new Error(`${PORTS_ENV_KEY} must read <from>-<to>, e.g. 20000-20099; got "${raw}"`);
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (from < 1024 || to > 65535 || to < from) {
    throw new Error(`${PORTS_ENV_KEY} must be an ascending range inside 1024-65535; got "${raw}"`);
  }
  return { from, to };
}

// ---------- the loopback relay ----------

/**
 * What a relay is, from the provider's side: a listener it can put up and take
 * down — and `close` means every byte, not just the next connection.
 */
export interface ExposureRelay {
  close(): void;
}

export type RelayFactory = (port: number, dial: ExposureDialer, label: string) => Promise<ExposureRelay>;

/**
 * One grant's relay: listens on `127.0.0.1:<extPort>` and dials the address
 * `dial` answers RIGHT NOW, per connection. A null answer destroys the
 * connection — fail closed, and never a fallback to anything remembered.
 * Bound to loopback explicitly: the tailnet is the perimeter, and a relay on
 * 0.0.0.0 would be a second, unapproved one.
 *
 * CLOSING IS THE SECURITY OPERATION, so it is not `server.close()`. That stops
 * the listener and leaves every ESTABLISHED pipe flowing — a released env's
 * data would keep reaching whoever was already connected, for as long as they
 * held the socket, which is exactly the promise ("an exposed port dies with
 * its env") inverted for the connections that matter most. So the relay owns
 * every socket it accepted and every upstream it opened, destroys them all on
 * close, and latches CLOSED so a dial still in flight cannot open a new pipe
 * behind the revocation.
 */
export const loopbackRelayFactory: RelayFactory = (port, dial, label) =>
  new Promise<ExposureRelay>((resolve, reject) => {
    const open = new Set<net.Socket>();
    let closed = false;
    const track = (socket: net.Socket): net.Socket => {
      open.add(socket);
      socket.on('close', () => open.delete(socket));
      return socket;
    };
    const server = net.createServer((socket) => {
      track(socket);
      socket.on('error', () => socket.destroy());
      void (async () => {
        let target: Awaited<ReturnType<ExposureDialer>> = null;
        try {
          target = await dial();
        } catch (error) {
          log.warn('Dev-env exposure: target resolution failed; refusing the connection', {
            exposure: label,
            error: String(error),
          });
        }
        if (!target || closed) {
          // A MISS is a refused connection: renamed away, deleted, the port no
          // longer served, or an instance mid-succession. Nothing stale ever
          // answers on an approved URL — and a revocation that landed while
          // this dial was in flight is the same refusal.
          socket.destroy();
          return;
        }
        const upstream = track(net.connect(target.port, target.address));
        upstream.on('error', () => {
          socket.destroy();
          upstream.destroy();
        });
        socket.on('close', () => upstream.destroy());
        upstream.on('close', () => socket.destroy());
        socket.pipe(upstream);
        upstream.pipe(socket);
      })();
    });
    server.on('error', (error) => reject(error));
    server.listen(port, '127.0.0.1', () => {
      server.removeAllListeners('error');
      server.on('error', (error) =>
        log.warn('Dev-env exposure: relay socket error', { exposure: label, error: String(error) }),
      );
      resolve({
        close: () => {
          closed = true;
          server.close();
          for (const socket of [...open]) socket.destroy();
        },
      });
    });
  });

// ---------- the provider ----------

export class TailnetExposureProvider implements ExposureProvider {
  readonly kind = TAILNET_PROVIDER_KIND;
  private host: string | undefined;
  private range: TailnetPortRange;
  private httpsVerified: boolean;
  private cli: Cli;
  private relayFactory: RelayFactory;
  /** extPort → the relay carrying that grant. The process's own state, rebuilt by heal. */
  private relays = new Map<number, ExposureRelay>();

  constructor(config: TailnetProviderConfig = {}) {
    this.host = config.host;
    this.range = config.range ?? DEFAULT_TAILNET_PORT_RANGE;
    this.httpsVerified = config.httpsVerified ?? false;
    this.cli = config.cli ?? realCli('tailscale');
    this.relayFactory = config.relayFactory ?? loopbackRelayFactory;
  }

  /**
   * Why this box cannot carry an exposure, or null when it can. Read at grant
   * (so the refusal names the fix) and at host start (so an operator learns
   * from the boot log rather than from an agent's first refusal).
   */
  unavailableReason(): string | null {
    if (!this.host) {
      return (
        `${HOST_ENV_KEY} is not set — the tailnet provider needs this box's MagicDNS name ` +
        '(e.g. dev-box.tail1234.ts.net), recorded at wire-host'
      );
    }
    if (!this.httpsVerified) {
      return (
        `${HTTPS_ENV_KEY} is not 'verified' — tailnet HTTPS needs MagicDNS plus the HTTPS-certificates ` +
        'feature enabled on this tailnet (a tailnet-admin action), and the first --https serve needs ' +
        "Let's Encrypt egress from this box; wire-host verifies it and records the verdict"
      );
    }
    return null;
  }

  reportUrl(draft: ExposureDraft, history: ExposureRow[]): { url: string; detail: Record<string, string> } {
    const unavailable = this.unavailableReason();
    if (unavailable) throw exposureRefusal('tailnet-unavailable', unavailable);
    const extPort = this.allocate(history);
    // The URL does not carry the NAME — under this provider the name lives in
    // the ledger and in the grant's own answer, which is exactly the gap a dns
    // provider closes. The port, and therefore the URL, is reusable after
    // revocation: an old bookmark eventually serves a different env, which is
    // why `renderExposure` prints a lifetime line beside every live row. The
    // admin card cannot say it — it is rendered from the command frame, before
    // this method has been called at all.
    return {
      url: `https://${this.host!}:${extPort}/`,
      detail: {
        [TAILNET_EXT_PORT]: String(extPort),
        // Recorded even when false, so a row always states what it is rather
        // than leaving a reader to infer it from an absent key.
        [TAILNET_BACKEND_TLS]: String(draft.backendTls === true),
      },
    };
  }

  async realize(binding: ExposureBinding): Promise<{ url: string }> {
    const unavailable = this.unavailableReason();
    if (unavailable) throw exposureRefusal('tailnet-unavailable', unavailable);
    const extPort = this.extPortOf(binding.grant);
    await this.assertRelay(extPort, binding);
    this.serve(extPort, this.backendTlsOf(binding.grant));
    return { url: `https://${this.host!}:${extPort}/` };
  }

  async revoke(grant: ExposureGrant): Promise<void> {
    // Must work with the env already gone: nothing here reads the target.
    const extPort = this.extPortOf(grant);
    this.unserve(extPort);
    this.relays.get(extPort)?.close();
    this.relays.delete(extPort);
  }

  /**
   * Both directions, inside this install's RANGE and nowhere else. Serve
   * config is device-global and its entries carry no labels, so the recorded
   * range IS the attribution: every write lands inside it, nothing outside it
   * is read as ours, and 443/6443 (governance, the apiserver) are therefore
   * untouchable by construction rather than by care.
   */
  async heal(bindings: ExposureBinding[]): Promise<void> {
    const desired = new Map<number, ExposureBinding>();
    for (const binding of bindings) {
      const extPort = this.extPortOf(binding.grant);
      if (!this.inRange(extPort)) {
        // A row from another install's range (a re-homed ledger, a
        // misconfiguration): not our territory, and we assert nothing on it.
        log.warn('Dev-env exposure: live grant sits outside this install range; leaving it alone', {
          exposure: binding.grant.name,
          extPort,
          range: `${this.range.from}-${this.range.to}`,
        });
        continue;
      }
      desired.set(extPort, binding);
    }
    for (const [extPort, binding] of desired) {
      try {
        await this.assertRelay(extPort, binding);
        this.serve(extPort, this.backendTlsOf(binding.grant));
      } catch (error) {
        log.warn('Dev-env exposure: could not re-assert a live exposure', {
          exposure: binding.grant.name,
          extPort,
          error: String(error),
        });
      }
    }
    // Strays: only ports this install's range accounts for, and only when the
    // status read succeeded — an unreadable status closes nothing.
    const served = this.servedPorts();
    if (!served) return;
    for (const extPort of served) {
      if (!this.inRange(extPort) || desired.has(extPort)) continue;
      log.warn('Dev-env exposure: closing a stray serve entry inside this install range', { extPort });
      this.unserve(extPort);
      this.relays.get(extPort)?.close();
      this.relays.delete(extPort);
    }
    for (const [extPort, relay] of this.relays) {
      if (desired.has(extPort)) continue;
      relay.close();
      this.relays.delete(extPort);
    }
  }

  /**
   * Host shutdown: the relays are process state and go with the process. The
   * serve entries and the ledger rows STAY — a restart's heal rebuilds the
   * relays from the rows, which is the same reason nothing here is a
   * revocation. Between the two the URL refuses, exactly as it does whenever
   * the host is down.
   */
  stop(): void {
    for (const relay of this.relays.values()) relay.close();
    this.relays.clear();
  }

  // ---------- internals ----------

  /**
   * Least-recently-revoked from the range, never-used ports first: the
   * never-deleted ledger rows ARE the recency record, so a freed port idles
   * as long as the range allows before an old URL can mean a new env. The
   * reuse hazard is real and aimed at humans (a bookmark, a chat-scrollback
   * URL); this ordering is what buys the longest possible idle, and the
   * lifetime line on the grant's own answer is what names the residual.
   *
   * A port's recency is its LAST ending, not its first. Once the range has
   * been round the block every port has several ended rows, and reading the
   * earliest one would hand back the port that was just freed while an older
   * idle port waits — the steady state, and the one place this ordering has
   * to hold. `history` arrives revoked-ascending, so re-inserting on every
   * ending leaves the set ordered by each port's most recent one.
   */
  private allocate(history: ExposureRow[]): number {
    const taken = new Set<number>();
    const freed = new Set<number>();
    for (const row of history) {
      const port = Number(row.providerDetail[TAILNET_EXT_PORT]);
      if (!Number.isInteger(port)) continue;
      if (row.state === 'pending' || row.state === 'live') {
        taken.add(port);
        continue;
      }
      // Delete-then-add is the move to the back of the queue: a Set keeps
      // insertion order, so the head stays the longest-idle port.
      freed.delete(port);
      freed.add(port);
    }
    for (let port = this.range.from; port <= this.range.to; port += 1) {
      if (!taken.has(port) && !freed.has(port)) return port;
    }
    for (const port of freed) {
      if (!taken.has(port)) return port;
    }
    throw exposureRefusal(
      'tailnet-range-exhausted',
      `every port in this install's range ${this.range.from}-${this.range.to} is in use by a live exposure; ` +
        'revoke one (ncl envs unexpose <env-id>) or widen the range at wire-host',
    );
  }

  /**
   * A row written before this key existed reads as `false`, which is what those
   * rows meant: every target was plaintext then. So an old ledger keeps working
   * and needs no migration.
   */
  private backendTlsOf(grant: ExposureGrant): boolean {
    return grant.providerDetail[TAILNET_BACKEND_TLS] === 'true';
  }

  private extPortOf(grant: ExposureGrant): number {
    const port = Number(grant.providerDetail[TAILNET_EXT_PORT]);
    if (!Number.isInteger(port)) {
      throw exposureRefusal(
        'tailnet-detail-missing',
        `exposure '${grant.name}' carries no ${TAILNET_EXT_PORT} — its row was not written by this provider`,
      );
    }
    return port;
  }

  private inRange(port: number): boolean {
    return port >= this.range.from && port <= this.range.to;
  }

  private assertInRange(port: number): void {
    if (this.inRange(port)) return;
    // A write outside the range would be this install touching another
    // install's (or governance's) territory. Refused, never clamped.
    throw exposureRefusal(
      'tailnet-out-of-range',
      `port ${port} is outside this install's reserved range ${this.range.from}-${this.range.to}`,
    );
  }

  private async assertRelay(extPort: number, binding: ExposureBinding): Promise<void> {
    this.assertInRange(extPort);
    if (this.relays.has(extPort)) return; // idempotent: realize is also the heal
    try {
      this.relays.set(extPort, await this.relayFactory(extPort, binding.dial, binding.grant.name));
    } catch (error) {
      throw exposureRefusal(
        'tailnet-relay-refused',
        `could not listen on 127.0.0.1:${extPort} for '${binding.grant.name}': ${String(error)}`,
      );
    }
  }

  private serve(extPort: number, backendTls: boolean): void {
    this.assertInRange(extPort);
    // See TAILNET_BACKEND_TLS for why the scheme has to be stated and why the
    // TLS form is the insecure one.
    const target = `${backendTls ? 'https+insecure' : 'http'}://127.0.0.1:${extPort}`;
    try {
      this.cli.run(['serve', '--bg', `--https=${extPort}`, target]);
    } catch (error) {
      throw this.serveRefusal(error, extPort);
    }
  }

  private unserve(extPort: number): void {
    this.assertInRange(extPort);
    try {
      this.cli.run(['serve', `--https=${extPort}`, 'off']);
    } catch (error) {
      // Teardown races teardown: an entry that is already gone is the desired
      // state, and only a real refusal is worth a line.
      log.warn('Dev-env exposure: tailscale serve off did not confirm', { extPort, error: String(error) });
    }
  }

  /** Null = we could not READ the device's serve config, which closes nothing. */
  private servedPorts(): number[] | null {
    let raw: string;
    try {
      raw = this.cli.run(['serve', 'status', '--json']);
    } catch (error) {
      log.warn('Dev-env exposure: tailscale serve status unreadable; asserting only', { error: String(error) });
      return null;
    }
    try {
      const parsed = JSON.parse(raw || '{}') as { TCP?: Record<string, unknown> };
      return Object.keys(parsed.TCP ?? {})
        .map((key) => Number(key))
        .filter((port) => Number.isInteger(port));
    } catch {
      log.warn('Dev-env exposure: tailscale serve status was not JSON; asserting only');
      return null;
    }
  }

  /**
   * The privilege seam, as a refusal an operator can act on. `tailscale serve`
   * needs root or the tailscale-operator grant, and "command failed" would
   * send a human to the wrong place.
   */
  private serveRefusal(error: unknown, extPort: number): Error {
    const text = String(error);
    if (/access denied|permission denied|must be root|operator|not allowed/i.test(text)) {
      return exposureRefusal(
        'tailnet-privilege',
        `this host user may not run 'tailscale serve' — grant it once at wire-host with ` +
          `'sudo tailscale set --operator=<host user>' (${text.slice(0, 200)})`,
      );
    }
    return exposureRefusal('tailnet-serve-refused', `tailscale serve --https=${extPort} failed: ${text.slice(0, 300)}`);
  }
}

/**
 * Registration, not selection — the same shape drivers use. A second provider
 * (the `dns` one C7 needs) registers its own kind beside this one and the
 * grant model never learns it exists.
 */
registerExposureProvider(TAILNET_PROVIDER_KIND, () => new TailnetExposureProvider(tailnetConfigFromEnv()));
