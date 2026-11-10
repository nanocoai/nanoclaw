import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { applySkill, fullyApplied } from '../../../../scripts/skill-apply.js';
import { gatePolicy } from '../../../../scripts/skill-policy.js';
import { advertisedProxy, proxyCheck, remoteProxyHint } from './remote-proxy.js';

const GATEWAY = 'http://gw.example.com:10254';
const advertising = (env: Record<string, string> = { HTTPS_PROXY: 'http://x:t@host.docker.internal:10255' }) =>
  vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ env }), { status: 200 }),
  );

describe('remote gateway proxy hint', () => {
  // (gateway, proxy it hands agents) -> the line the hint names, or null for no hint.
  it.each([
    [GATEWAY, 'host.docker.internal:10255', 'GATEWAY_BASE_URL=gw.example.com:10255'],
    [GATEWAY, '127.0.0.1:10255', 'GATEWAY_BASE_URL=gw.example.com:10255'],
    [GATEWAY, 'localhost:10255', 'GATEWAY_BASE_URL=gw.example.com:10255'],
    [GATEWAY, 'localhost.:10255', 'GATEWAY_BASE_URL=gw.example.com:10255'],
    [GATEWAY, '[::1]:10255', 'GATEWAY_BASE_URL=gw.example.com:10255'],
    [GATEWAY, '0.0.0.0:10255', 'GATEWAY_BASE_URL=gw.example.com:10255'],
    [GATEWAY, '[::]:10255', 'GATEWAY_BASE_URL=gw.example.com:10255'],
    [GATEWAY, 'host.docker.internal:20255', 'GATEWAY_BASE_URL=gw.example.com:20255'],
    [GATEWAY, 'gw.example.com:10255', null],
    [GATEWAY, '10.0.0.5:10255', null],
    ['http://127.0.0.1:10254', 'host.docker.internal:10255', null],
    ['http://localhost:10254', 'host.docker.internal:10255', null],
    ['http://localhost.:10254', 'host.docker.internal:10255', null],
    ['http://[::1]:10254', 'host.docker.internal:10255', null],
    ['http://0.0.0.0:10254', 'host.docker.internal:10255', null],
    ['http://[::]:10254', 'host.docker.internal:10255', null],
    [GATEWAY, null, null],
  ])('gateway %s, proxy %s: %s', (gateway, advertised, line) => {
    const hint = remoteProxyHint(gateway, advertised ? new URL(`http://x:aoc_secret@${advertised}`) : null);
    if (line === null) {
      expect(hint).toBeNull();
      return;
    }
    expect(hint).toContain(line);
    expect(hint).toContain(`ONECLI_GATEWAY_PORT in place of ${line.split(':')[1]}`);
    expect(hint).toContain('Remote gateway');
    // The proxy URL carries the agent token.
    expect(hint).not.toContain('aoc_secret');
  });

  it("treats a gateway URL on one of this machine's own addresses as local", () => {
    const nic = { netmask: '', mac: '00:00:00:00:00:00', internal: false, cidr: null };
    const spy = vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      en0: [
        { ...nic, address: '192.168.1.20', family: 'IPv4' },
        { ...nic, address: 'fd00::20', family: 'IPv6', scopeid: 0 },
      ],
    });
    try {
      const proxy = new URL('http://x:t@host.docker.internal:10255');
      expect(remoteProxyHint('http://192.168.1.20:10254', proxy)).toBeNull();
      expect(remoteProxyHint('http://[fd00::20]:10254', proxy)).toBeNull();
      expect(remoteProxyHint('http://192.168.1.21:10254', proxy)).toContain('GATEWAY_BASE_URL=192.168.1.21:10255');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('advertised proxy', () => {
  it("reads the default agent's proxy", async () => {
    const fetchImpl = advertising();
    const got = await advertisedProxy(`${GATEWAY}/`, 'oc_key', fetchImpl as unknown as typeof fetch);
    expect(got?.host).toBe('host.docker.internal:10255');
    expect(fetchImpl.mock.calls[0][0]).toBe(`${GATEWAY}/v1/container-config?agent=default`);
  });

  it('gives null for an answer with no proxy', async () => {
    expect(await advertisedProxy(GATEWAY, undefined, advertising({}) as unknown as typeof fetch)).toBeNull();
  });
});

describe('proxy check after setup', () => {
  it('warns for a remote gateway that sends agents to their own machine, asking with the saved key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-proxy-key-'));
    writeFileSync(join(dir, '.env'), 'ONECLI_API_KEY=oc_key\n');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      const fetchImpl = advertising();
      const got = await proxyCheck({ NANOCLAW_ONECLI_API_HOST: GATEWAY }, fetchImpl as unknown as typeof fetch);
      expect(got.warn).toBe('yes');
      expect(got.hint).toContain('GATEWAY_BASE_URL=gw.example.com:10255');
      expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer oc_key');
    } finally {
      cwd.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
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
    const env = { NANOCLAW_ONECLI_API_HOST: 'not a url' };
    expect(await proxyCheck(env, advertising() as unknown as typeof fetch)).toEqual({ warn: 'no', hint: 'none' });
  });
});

// The wizard shows the skill's operator notes on screen; setup.ts output only reaches logs/setup.log.
describe('the skill shows the hint', () => {
  const md = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
  const hint = remoteProxyHint(GATEWAY, new URL('http://x:t@host.docker.internal:10255'))!;

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
