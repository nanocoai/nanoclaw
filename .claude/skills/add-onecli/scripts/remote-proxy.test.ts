import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { applySkill, fullyApplied } from '../../../../scripts/skill-apply.js';
import { gatePolicy } from '../../../../scripts/skill-policy.js';
import { advertisedProxy, proxyCheck, remoteProxyHint } from './remote-proxy.js';

const GATEWAY = 'http://gw.example.com:10254';
const proxy = (url: string) => new URL(url);

describe('remote gateway proxy hint', () => {
  it.each([
    'http://x:aoc_secret@host.docker.internal:10255',
    'http://x:aoc_secret@127.0.0.1:10255',
    'http://x:aoc_secret@localhost:10255',
    'http://x:aoc_secret@[::1]:10255',
    'http://x:aoc_secret@[::ffff:127.0.0.1]:10255',
    'http://x:aoc_secret@0.0.0.0:10255',
    'http://x:aoc_secret@[::]:10255',
  ])('names the exact line to set when agents are sent to their own machine (%s)', (advertised) => {
    const hint = remoteProxyHint(GATEWAY, proxy(advertised))!;
    expect(hint).toContain('GATEWAY_BASE_URL=gw.example.com:10255');
    expect(hint).toContain('Remote gateway');
    // The proxy URL carries the agent token.
    expect(hint).not.toContain('aoc_secret');
  });

  it('keeps the port the gateway hands out, and names the published port it cannot see', () => {
    const hint = remoteProxyHint(GATEWAY, proxy('http://x:t@host.docker.internal:20255'))!;
    expect(hint).toContain('GATEWAY_BASE_URL=gw.example.com:20255');
    // OneCLI advertises its default port even when ONECLI_GATEWAY_PORT publishes another.
    expect(hint).toContain('ONECLI_GATEWAY_PORT in place of 20255');
  });

  it.each(['http://x:t@gw.example.com:10255', 'http://x:t@10.0.0.5:10255'])('says nothing for %s', (advertised) => {
    expect(remoteProxyHint(GATEWAY, proxy(advertised))).toBeNull();
  });

  // A gateway reached at this machine's own address is local: host.docker.internal is right for it.
  it.each(['http://127.0.0.1:10254', 'http://localhost:10254', 'http://0.0.0.0:10254', 'http://[::]:10254'])(
    'says nothing when the gateway URL %s is this machine',
    (gateway) => {
      expect(remoteProxyHint(gateway, proxy('http://x:t@host.docker.internal:10255'))).toBeNull();
      expect(remoteProxyHint(gateway, proxy('http://x:t@0.0.0.0:10255'))).toBeNull();
    },
  );

  it('says nothing when the proxy could not be read', () => {
    expect(remoteProxyHint(GATEWAY, null)).toBeNull();
  });
});

describe('advertised proxy', () => {
  const answer = (status: number, body: unknown) =>
    vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));

  it("reads the default agent's proxy, with the API key", async () => {
    const fetchImpl = answer(200, { env: { HTTPS_PROXY: 'http://x:t@host.docker.internal:10255' } });
    const got = await advertisedProxy(`${GATEWAY}/`, 'oc_key', fetchImpl as unknown as typeof fetch);
    expect(got?.host).toBe('host.docker.internal:10255');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${GATEWAY}/v1/container-config?agent=default`);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer oc_key');
  });

  it.each([
    ['a refused request', answer(401, {})],
    ['no proxy in the answer', answer(200, { env: {} })],
    ['a proxy that is not a URL', answer(200, { env: { HTTPS_PROXY: 'not a url' } })],
    [
      'an unreachable gateway',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    ],
  ])('gives null for %s', async (_case, fetchImpl) => {
    expect(await advertisedProxy(GATEWAY, undefined, fetchImpl as unknown as typeof fetch)).toBeNull();
  });
});

describe('proxy check after setup', () => {
  const advertising = () =>
    vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ env: { HTTPS_PROXY: 'http://x:t@host.docker.internal:10255' } }), {
          status: 200,
        }),
    );

  it('warns for a remote gateway that sends agents to their own machine, asking with the setup token', async () => {
    const fetchImpl = advertising();
    const env = { NANOCLAW_ONECLI_API_HOST: GATEWAY, NANOCLAW_ONECLI_API_TOKEN: 'oc_key' };
    const got = await proxyCheck(env, fetchImpl as unknown as typeof fetch);
    expect(got.warn).toBe('yes');
    expect(got.hint).toContain('GATEWAY_BASE_URL=gw.example.com:10255');
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer oc_key');
  });

  it('asks nothing when setup was not pointed at a remote gateway', async () => {
    const fetchImpl = advertising();
    expect(await proxyCheck({}, fetchImpl as unknown as typeof fetch)).toEqual({ warn: 'no', hint: 'none' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // SKILL.md runs this file and binds its stdout as JSON; empty output fails the install.
  it('prints its verdict as JSON when the checkout path has a space', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-proxy-'));
    const repo = join(dir, 'Nano Claw');
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    symlinkSync(root, repo);
    try {
      const env = { ...process.env, NANOCLAW_ONECLI_API_HOST: '' };
      const script = join(repo, '.claude/skills/add-onecli/scripts/proxy-check.ts');
      const loader = join(root, 'node_modules/tsx/dist/loader.mjs');
      const out = execFileSync(process.execPath, ['--import', loader, script], { cwd: dir, env, encoding: 'utf8' });
      expect(JSON.parse(out)).toEqual({ warn: 'no', hint: 'none' });
    } finally {
      unlinkSync(repo);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('never fails, even when the gateway address is not a URL', async () => {
    const env = { NANOCLAW_ONECLI_API_HOST: 'not a url', NANOCLAW_ONECLI_API_TOKEN: 'k' };
    expect(await proxyCheck(env, advertising() as unknown as typeof fetch)).toEqual({ warn: 'no', hint: 'none' });
  });
});

// The wizard runs the skill and shows its operator notes on screen; the
// setup script's own output only reaches logs/setup.log.
describe('the skill shows the hint', () => {
  const md = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
  const hint = remoteProxyHint(GATEWAY, proxy('http://x:t@host.docker.internal:10255'))!;

  it.each([
    ['shows the hint when the check warns', { warn: 'yes', hint }, [hint]],
    ['shows nothing when it does not', { warn: 'no', hint: 'none' }, []],
  ])('%s', async (_case, verdict, notes) => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-onecli-proxy-'));
    try {
      writeFileSync(join(dir, 'SKILL.md'), md.slice(md.indexOf('## Check the proxy address')));
      const exec = (cmd: string) => (cmd.includes('scripts/proxy-check.ts') ? JSON.stringify(verdict) : '');
      const res = await applySkill(dir, dir, { exec });
      expect(fullyApplied(res)).toBe(true);
      expect(res.operatorMessages).toEqual(notes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shows it without holding the wizard for a confirm', () => {
    expect([...gatePolicy(md).values()].map((gate) => gate.needsConfirm)).toEqual([false]);
  });
});
