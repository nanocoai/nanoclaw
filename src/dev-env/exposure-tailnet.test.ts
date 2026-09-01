/**
 * The tailnet exposure provider (C14, v1) — against a fake `tailscale` and
 * REAL loopback sockets.
 *
 * The sockets are the point of two of these blocks: "dial by resolution,
 * never by memory" is a claim about what happens per connection, and the only
 * way to prove it is to open connections and watch where they land — before a
 * service moves, during the gap, and after.
 */
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Cli, SupervisedProcess } from '../drivers/cli.js';

import { isExposureRefusal, type ExposureBinding, type ExposureDraft } from './exposure-provider.js';
import type { ExposureRow } from './exposure.js';
import { TAILNET_EXT_PORT, TailnetExposureProvider, parsePortRange, tailnetConfigFromEnv } from './exposure-tailnet.js';

const HOST = 'dev-box.tail1234.ts.net';

/** Records every argv, and can be told to refuse the next `serve` like the real CLI does. */
class FakeTailscale implements Cli {
  readonly bin = 'tailscale';
  readonly calls: string[][] = [];
  /** What `serve status --json` answers; null makes the read fail outright. */
  status: string | null = '{"TCP":{}}';
  failServeWith: string | null = null;

  run(args: string[]): string {
    this.calls.push(args);
    if (args[1] === 'status') {
      if (this.status === null) throw new Error('failed to connect to local tailscaled');
      return this.status;
    }
    if (this.failServeWith) throw new Error(this.failServeWith);
    return '';
  }

  start(): SupervisedProcess {
    throw new Error('the tailnet provider never starts a supervised process');
  }

  serveArgs(): string[][] {
    return this.calls.filter((call) => call[0] === 'serve' && call[1] !== 'status');
  }
}

function row({
  extPort,
  ...overrides
}: Partial<ExposureRow> & { name: string; extPort: number }): ExposureRow {
  return {
    exposureId: `expo-${overrides.name}`,
    envId: 'env-1',
    service: 'default/backlot',
    port: 8080,
    provider: 'tailnet',
    providerDetail: { [TAILNET_EXT_PORT]: String(extPort) },
    url: `https://${HOST}:${extPort}/`,
    ownerRef: 'g-agent',
    approvedBy: 'operator',
    state: 'live',
    claimantSessionId: null,
    createdAt: '2026-08-24T00:00:00.000Z',
    revokedAt: null,
    revokeCause: null,
    ...overrides,
  };
}

const DRAFT: ExposureDraft = { name: 'backlot-1', envId: 'env-1', service: 'default/backlot', port: 8080 };

function bindingFor(name: string, extPort: number, dial: ExposureBinding['dial']): ExposureBinding {
  return {
    grant: {
      exposureId: `expo-${name}`,
      name,
      envId: 'env-1',
      service: 'default/backlot',
      port: 8080,
      url: `https://${HOST}:${extPort}/`,
      providerDetail: { [TAILNET_EXT_PORT]: String(extPort) },
    },
    dial,
  };
}

let cli: FakeTailscale;
const closers: Array<() => void> = [];

/** A port nothing holds right now — the relay tests bind for real. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

/** An upstream that echoes its own address back — so a connection SAYS where it landed. */
async function echoServer(label: string): Promise<{ address: string; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => socket.destroy());
      socket.end(label);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      closers.push(() => server.close());
      resolve({ address: '127.0.0.1', port: (server.address() as net.AddressInfo).port });
    });
  });
}

/**
 * An upstream that answers and then HOLDS the connection open — no `end()`.
 * The established-connection test needs a pipe that only a teardown can close,
 * or "the connection died" would prove nothing about who killed it.
 */
async function holdingServer(label: string): Promise<{ address: string; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => socket.destroy());
      closers.push(() => socket.destroy());
      socket.write(label);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      closers.push(() => server.close());
      resolve({ address: '127.0.0.1', port: (server.address() as net.AddressInfo).port });
    });
  });
}

/** What a browser would get: the upstream's label, or '' when the relay refused. */
async function probeRelay(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    socket.setTimeout(2_000, () => socket.destroy());
    socket.on('data', (chunk) => (received += chunk.toString()));
    socket.on('error', () => resolve(received));
    socket.on('close', () => resolve(received));
  });
}

beforeEach(() => {
  cli = new FakeTailscale();
});

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

describe('what this box must have', () => {
  it('refuses at grant when the tailnet name was never recorded, naming wire-host', () => {
    const provider = new TailnetExposureProvider({ httpsVerified: true, cli });
    expect(provider.unavailableReason()).toContain('NANOCLAW_DEV_ENV_EXPOSURE_TAILNET_HOST');
    try {
      provider.reportUrl(DRAFT, []);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isExposureRefusal(error)).toBe(true);
      expect(String(error)).toContain('MagicDNS name');
    }
  });

  it('refuses when tailnet HTTPS was not VERIFIED — a granted row whose URL cannot serve is the ordering violated', () => {
    const provider = new TailnetExposureProvider({ host: HOST, cli });
    expect(provider.unavailableReason()).toContain('HTTPS-certificates');
    expect(() => provider.reportUrl(DRAFT, [])).toThrow(/verified/);
    // Nothing was said to tailscaled on the way to that refusal.
    expect(cli.calls).toEqual([]);
  });

  it('reads the verdict, the name and the range from host configuration', () => {
    const config = tailnetConfigFromEnv({
      NANOCLAW_DEV_ENV_EXPOSURE_TAILNET_HOST: HOST,
      NANOCLAW_DEV_ENV_EXPOSURE_TAILNET_PORTS: '20500-20599',
      NANOCLAW_DEV_ENV_EXPOSURE_TAILNET_HTTPS: 'verified',
    } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({ host: HOST, range: { from: 20500, to: 20599 }, httpsVerified: true });
    expect(parsePortRange(undefined)).toBeUndefined();
    for (const bad of ['20000', '20099-20000', 'a-b', '80-90']) {
      expect(() => parsePortRange(bad), bad).toThrow();
    }
  });
});

describe('allocation', () => {
  const provider = (): TailnetExposureProvider =>
    new TailnetExposureProvider({ host: HOST, httpsVerified: true, range: { from: 20000, to: 20002 }, cli });

  it('takes a never-used port first, and the URL it states is the one the grant keeps', () => {
    const { url, detail } = provider().reportUrl(DRAFT, [row({ name: 'a', extPort: 20000 })]);
    expect(detail[TAILNET_EXT_PORT]).toBe('20001');
    expect(url).toBe(`https://${HOST}:20001/`);
    // The NAME is not in the URL — under this provider it lives in the ledger
    // and in what the read surfaces print, which is exactly the gap a dns
    // provider closes.
    expect(url).not.toContain(DRAFT.name);
  });

  it('reuses the LEAST-recently-revoked port once the range has been round the block', () => {
    // Every port used; 20001 was freed first, so it has idled longest.
    const history = [
      row({ name: 'live', extPort: 20002 }),
      row({ name: 'oldest', extPort: 20001, state: 'revoked', revokedAt: '2026-08-01T00:00:00.000Z' }),
      row({ name: 'newer', extPort: 20000, state: 'revoked', revokedAt: '2026-08-20T00:00:00.000Z' }),
    ];
    expect(provider().reportUrl(DRAFT, history).detail[TAILNET_EXT_PORT]).toBe('20001');
  });

  it("orders reuse by a port's LAST ending, not its first — the state the range is in after it cycles", () => {
    // 20000 has been round twice; its most recent ending is the newest of the
    // three, so the port that has actually idled longest is 20001. Reading the
    // FIRST ending would hand back the port freed a minute ago and defeat the
    // only mitigation this provider has for URL reuse.
    const history = [
      row({ name: 'a1', extPort: 20000, state: 'revoked', revokedAt: '2026-08-01T00:00:00.000Z' }),
      row({ name: 'b', extPort: 20001, state: 'revoked', revokedAt: '2026-08-10T00:00:00.000Z' }),
      row({ name: 'c', extPort: 20002, state: 'revoked', revokedAt: '2026-08-15T00:00:00.000Z' }),
      row({ name: 'a2', extPort: 20000, state: 'revoked', revokedAt: '2026-08-20T00:00:00.000Z' }),
    ];
    expect(provider().reportUrl(DRAFT, history).detail[TAILNET_EXT_PORT]).toBe('20001');
  });

  it('refuses when every port in the range is held by a live exposure', () => {
    const history = [20000, 20001, 20002].map((extPort) => row({ name: `x${extPort}`, extPort }));
    expect(() => provider().reportUrl(DRAFT, history)).toThrow(/range 20000-20002 is in use/);
  });
});

describe('the serve entry', () => {
  it('is HTTPS to loopback, inside the range, and never raw TCP', async () => {
    const port = await freePort();
    const provider = new TailnetExposureProvider({
      host: HOST,
      httpsVerified: true,
      range: { from: port, to: port },
      cli,
    });
    const target = await echoServer('upstream');
    await provider.realize(bindingFor('backlot-1', port, async () => ({ service: 'default/backlot', ...target })));

    expect(cli.serveArgs()).toEqual([['serve', '--bg', `--https=${port}`, `http://127.0.0.1:${port}`]]);
    // The ruling on question 3: HTTPS only in v1 — there is no --tcp path to take.
    expect(cli.calls.flat().join(' ')).not.toContain('--tcp');
    provider.stop();
  });

  it('names the privilege seam when tailscaled refuses the write', async () => {
    const port = await freePort();
    const provider = new TailnetExposureProvider({
      host: HOST,
      httpsVerified: true,
      range: { from: port, to: port },
      cli,
    });
    cli.failServeWith = 'access denied: serve requires operator or root';
    await expect(
      provider.realize(bindingFor('backlot-1', port, async () => ({ service: 'default/backlot', address: '127.0.0.1', port: 1 }))),
    ).rejects.toThrow(/tailscale set --operator=/);
    provider.stop();
  });

  it("closes with the off form, and refuses to write outside this install's range", async () => {
    const port = await freePort();
    const provider = new TailnetExposureProvider({
      host: HOST,
      httpsVerified: true,
      range: { from: port, to: port },
      cli,
    });
    await provider.revoke(bindingFor('backlot-1', port, async () => null).grant);
    expect(cli.serveArgs()).toEqual([['serve', `--https=${port}`, 'off']]);

    // 443 is governance's and 6443 is the apiserver's: outside the recorded
    // range is not this install's territory, and a write there is refused
    // rather than clamped.
    await expect(provider.revoke(bindingFor('stray', 443, async () => null).grant)).rejects.toThrow(
      /outside this install's reserved range/,
    );
    expect(cli.serveArgs()).toHaveLength(1);
  });
});

describe('the relay dials by resolution, never by memory', () => {
  it('lands on the address resolved AT CONNECT TIME, follows a move, and refuses a miss', async () => {
    const port = await freePort();
    const provider = new TailnetExposureProvider({
      host: HOST,
      httpsVerified: true,
      range: { from: port, to: port },
      cli,
    });
    const first = await echoServer('first');
    const second = await echoServer('second');
    let target: { address: string; port: number } | null = first;

    await provider.realize(
      bindingFor('backlot-1', port, async () => (target ? { service: 'default/backlot', ...target } : null)),
    );

    expect(await probeRelay(port)).toBe('first');

    // The agent deletes and recreates the Service: nothing stale answers in
    // the gap, and the next connection follows the name to its new address.
    target = null;
    expect(await probeRelay(port)).toBe('');
    target = second;
    expect(await probeRelay(port)).toBe('second');

    // Revocation kills the listener outright.
    await provider.revoke(bindingFor('backlot-1', port, async () => null).grant);
    expect(await probeRelay(port)).toBe('');
    provider.stop();
  });

  it('kills a connection that was ALREADY ESTABLISHED — the hole dies with the env, not with its next request', async () => {
    // Closing the listener only refuses the NEXT connection. A browser (or a
    // websocket, or a long poll) that was already through keeps reading a
    // released env's data for as long as it holds the socket, which is the
    // central promise inverted for the connections that matter most.
    const port = await freePort();
    const provider = new TailnetExposureProvider({
      host: HOST,
      httpsVerified: true,
      range: { from: port, to: port },
      cli,
    });
    const target = await holdingServer('held');
    const binding = bindingFor('backlot-1', port, async () => ({ service: 'default/backlot', ...target }));
    await provider.realize(binding);

    const held = net.connect(port, '127.0.0.1');
    closers.push(() => held.destroy());
    await new Promise<void>((resolve, reject) => {
      held.setTimeout(2_000, () => reject(new Error('the relay never carried the connection')));
      held.on('error', reject);
      held.on('data', () => resolve());
    });

    const died = new Promise<boolean>((resolve) => {
      held.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 2_000).unref?.();
    });
    await provider.revoke(binding.grant);
    expect(await died).toBe(true);
    provider.stop();
  });

  it('refuses the grant when the loopback port cannot be listened on, rather than serving a dead entry', async () => {
    const port = await freePort();
    const squatter = net.createServer();
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', () => resolve()));
    closers.push(() => squatter.close());

    const provider = new TailnetExposureProvider({
      host: HOST,
      httpsVerified: true,
      range: { from: port, to: port },
      cli,
    });
    await expect(
      provider.realize(bindingFor('backlot-1', port, async () => ({ service: 's', address: '127.0.0.1', port: 1 }))),
    ).rejects.toThrow(/could not listen on 127.0.0.1/);
    // The serve entry is never written for a relay that does not exist.
    expect(cli.serveArgs()).toEqual([]);
    provider.stop();
  });
});

describe('heal attributes by the recorded range', () => {
  it('re-asserts live grants, closes strays INSIDE the range, and never touches anything outside it', async () => {
    const port = await freePort();
    const provider = new TailnetExposureProvider({
      host: HOST,
      httpsVerified: true,
      range: { from: port, to: port + 1 },
      cli,
    });
    // The device-global serve config: ours, a stray in our range, and
    // governance's 443 + the apiserver's 6443, which are not ours to read.
    cli.status = JSON.stringify({ TCP: { [port]: {}, [port + 1]: {}, 443: {}, 6443: {} } });
    const target = await echoServer('upstream');

    await provider.heal([bindingFor('backlot-1', port, async () => ({ service: 'default/backlot', ...target }))]);

    expect(cli.serveArgs()).toEqual([
      ['serve', '--bg', `--https=${port}`, `http://127.0.0.1:${port}`],
      ['serve', `--https=${port + 1}`, 'off'],
    ]);
    provider.stop();
  });

  it('closes nothing when the device config cannot be READ — an unreadable status is not an empty one', async () => {
    const port = await freePort();
    const provider = new TailnetExposureProvider({
      host: HOST,
      httpsVerified: true,
      range: { from: port, to: port + 1 },
      cli,
    });
    cli.status = null;
    const target = await echoServer('upstream');

    await provider.heal([bindingFor('backlot-1', port, async () => ({ service: 'default/backlot', ...target }))]);

    // Asserted ours; closed nothing.
    expect(cli.serveArgs()).toEqual([['serve', '--bg', `--https=${port}`, `http://127.0.0.1:${port}`]]);
    provider.stop();
  });

  it("leaves a grant from another install's range alone instead of asserting into it", async () => {
    const port = await freePort();
    const provider = new TailnetExposureProvider({
      host: HOST,
      httpsVerified: true,
      range: { from: port, to: port },
      cli,
    });
    cli.status = JSON.stringify({ TCP: {} });

    await provider.heal([bindingFor('elsewhere', 30000, async () => null)]);

    expect(cli.serveArgs()).toEqual([]);
    provider.stop();
  });
});
