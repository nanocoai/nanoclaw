import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  advertisedProxy,
  checkRemoteProxy,
  ipAddrAddresses,
  ownAddresses,
  gatewayRecreateCommand,
  readContainerConfig,
  remoteProxyHint,
  runtimeGateway,
} from './remote-proxy.js';

const TOKEN = 'aoc_secret_agent_token_value';
const GATEWAY = 'http://192.168.107.212:10254';
// What OneCLI 1.42/1.45 return from GET /v1/container-config: the proxy is
// http://x:<agent token>@${GATEWAY_BASE_URL}.
const config = (base: string) => ({
  env: { HTTPS_PROXY: `http://x:${TOKEN}@${base}`, HTTP_PROXY: `http://x:${TOKEN}@${base}` },
  caCertificate: '-----BEGIN CERTIFICATE-----',
});
const own = ['127.0.0.1', '172.17.0.1', '192.168.107.215'];

// docker0 with no container attached: Node's list leaves it out, `ip` does not.
const nodeInterfaces = {
  lo: [{ address: '127.0.0.1' }, { address: '::1' }],
  eth0: [{ address: '192.168.107.215' }],
} as unknown as ReturnType<typeof os.networkInterfaces>;
const IP_ADDR = [
  '1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever',
  '1: lo    inet6 ::1/128 scope host noprefixroute \\       valid_lft forever preferred_lft forever',
  '2: eth0    inet 192.168.107.215/24 brd 192.168.107.255 scope global eth0\\       valid_lft forever preferred_lft forever',
  '3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever preferred_lft forever',
  '3: docker0    inet6 fe80::42:acff:fe11:1/64 scope link \\       valid_lft forever preferred_lft forever',
].join('\n');
const linuxDownBridge = () => ownAddresses({ interfaces: nodeInterfaces, platform: 'linux', ipAddr: () => IP_ADDR });

describe('advertisedProxy', () => {
  it('reads the proxy the gateway hands agents', () => {
    expect(advertisedProxy(config('host.docker.internal:10255'))?.host).toBe('host.docker.internal:10255');
    expect(advertisedProxy({ env: { http_proxy: `http://x:${TOKEN}@10.0.0.9:10255` } })?.host).toBe('10.0.0.9:10255');
  });

  it('returns null for a config without a usable proxy', () => {
    for (const bad of [null, 'text', {}, { env: {} }, { env: { HTTPS_PROXY: 'not a url' } }]) {
      expect(advertisedProxy(bad)).toBeNull();
    }
  });
});

describe('remoteProxyHint', () => {
  it('warns when a remote gateway points agents at their own machine, with the exact fix', () => {
    for (const base of ['host.docker.internal:10255', 'localhost:10255', '127.0.0.1:10255']) {
      const hint = remoteProxyHint(GATEWAY, config(base), [], own);
      expect(hint).toContain(base);
      expect(hint).toContain(gatewayRecreateCommand('192.168.107.212'));
      expect(hint).not.toContain('env -u ONECLI_VERSION');
      expect(hint).not.toContain('\n');
    }
  });

  it("warns when a remote gateway hands out an address of the agent's own host", () => {
    const hint = remoteProxyHint(GATEWAY, config('172.17.0.1:10255'), [], own);
    expect(hint).toContain('172.17.0.1:10255');
  });

  it('keeps a hostname that is not plain out of the shell command', () => {
    const hint = remoteProxyHint('http://$(id).example:10254', config('host.docker.internal:10255'), [], own) ?? '';
    expect(hint).not.toContain('$(id)');
    expect(hint).toContain(gatewayRecreateCommand('<gateway-host>'));
  });

  it('never prints the agent token or proxy credentials', () => {
    const hint = remoteProxyHint(GATEWAY, config('host.docker.internal:10255'), [], own) ?? '';
    expect(hint).not.toContain(TOKEN);
    expect(hint).not.toContain('x:');
    expect(hint).not.toContain('@');
  });

  it('stays quiet once the gateway hands out an address agents can reach', () => {
    expect(remoteProxyHint(GATEWAY, config('192.168.107.212:10255'), [], own)).toBeNull();
    expect(remoteProxyHint(GATEWAY, config('onecli.example.net:10255'), [], own)).toBeNull();
  });

  it('stays quiet when the "remote" gateway is on this machine', () => {
    for (const url of ['http://127.0.0.1:10254', 'http://172.17.0.1:10254', 'http://192.168.107.215:10254']) {
      expect(remoteProxyHint(url, config('host.docker.internal:10255'), [], own)).toBeNull();
    }
  });

  it('judges a gateway name by the addresses it resolves to', () => {
    const named = 'http://nanoclaw.local:10254';
    expect(remoteProxyHint(named, config('host.docker.internal:10255'), ['192.168.107.215'], own)).toBeNull();
    expect(remoteProxyHint(named, config('host.docker.internal:10255'), ['192.168.107.212'], own)).toContain(
      gatewayRecreateCommand('nanoclaw.local'),
    );
  });

  it('stays quiet when the config has no proxy', () => {
    expect(remoteProxyHint(GATEWAY, { env: {} }, [], own)).toBeNull();
  });
});

describe('ipAddrAddresses', () => {
  it('reads every address `ip -o addr show` lists, down interfaces included', () => {
    expect(ipAddrAddresses(IP_ADDR)).toEqual([
      '127.0.0.1',
      '::1',
      '192.168.107.215',
      '172.17.0.1',
      'fe80::42:acff:fe11:1',
    ]);
  });

  it('takes the local side of a point-to-point address and skips anything else', () => {
    expect(ipAddrAddresses('4: wg0    inet 10.8.0.2 peer 10.8.0.1/32 scope global wg0\\')).toEqual(['10.8.0.2']);
    expect(ipAddrAddresses('5: inet    inet 10.9.0.1/24 scope global inet\\')).toEqual(['10.9.0.1']);
    expect(ipAddrAddresses('')).toEqual([]);
    expect(ipAddrAddresses('Object "addr" is unknown, try "ip help".')).toEqual([]);
  });
});

describe('ownAddresses', () => {
  it('counts a down docker bridge on Linux, which Node leaves out', () => {
    expect(linuxDownBridge()).toContain('172.17.0.1');
    expect(linuxDownBridge()).toContain('192.168.107.215');
    expect(linuxDownBridge()).not.toContain('192.168.107.212');
  });

  it("falls back to Node's list when ip is missing or fails", () => {
    const ipAddr = () => {
      throw new Error('spawnSync ip ENOENT');
    };
    expect(ownAddresses({ interfaces: nodeInterfaces, platform: 'linux', ipAddr })).toEqual([
      '127.0.0.1',
      '::1',
      '192.168.107.215',
    ]);
  });

  it('asks only Node off Linux, where there is no ip', () => {
    const ipAddr = vi.fn(() => IP_ADDR);
    expect(ownAddresses({ interfaces: nodeInterfaces, platform: 'darwin', ipAddr })).not.toContain('172.17.0.1');
    expect(ipAddr).not.toHaveBeenCalled();
  });
});

describe('readContainerConfig', () => {
  it('asks the default agent config with the API token, like the SDK', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(config('host.docker.internal:10255'))));
    const res = await readContainerConfig('http://192.168.107.212:10254/', TOKEN, fetchImpl);
    expect(res).toEqual({ ok: true, config: config('host.docker.internal:10255') });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // Naming the seeded agent: without it OneCLI creates a default agent.
    expect(url).toBe('http://192.168.107.212:10254/v1/container-config?agent=default');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('falls back to the current default agent, and never asks without naming one', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('agent=default')) return new Response('{}', { status: 404 });
      if (url.endsWith('/v1/agents')) {
        return new Response(
          JSON.stringify([
            { identifier: 'ag-1', isDefault: false },
            { identifier: 'main', isDefault: true },
          ]),
        );
      }
      return new Response(JSON.stringify(config('host.docker.internal:10255')));
    });
    const res = await readContainerConfig(GATEWAY, TOKEN, fetchImpl as unknown as typeof fetch);
    expect(res.ok).toBe(true);
    expect(calls[calls.length - 1]).toBe(`${GATEWAY}/v1/container-config?agent=main`);
    expect(calls.every((u) => !u.endsWith('/v1/container-config'))).toBe(true);
  });

  it('gives up without an agent to read', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/v1/agents') ? new Response('[]') : new Response('{}', { status: 404 }),
    );
    expect(await readContainerConfig(GATEWAY, TOKEN, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: 'no agent to read',
    });
  });

  it('reports, never throws, when the config cannot be read', async () => {
    const refused = vi.fn(async () => new Response('nope', { status: 401 }));
    expect(await readContainerConfig(GATEWAY, undefined, refused)).toEqual({ ok: false, reason: 'status 401' });
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await readContainerConfig(GATEWAY, TOKEN, down)).ok).toBe(false);
    const garbled = vi.fn(async () => new Response('<html>'));
    expect((await readContainerConfig(GATEWAY, TOKEN, garbled)).ok).toBe(false);
  });

  it('keeps the token out of the failure reason', async () => {
    const down = vi.fn(async () => {
      throw new Error(`connect failed for Bearer ${TOKEN}`);
    });
    const res = await readContainerConfig(GATEWAY, TOKEN, down);
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });
});

describe('checkRemoteProxy', () => {
  const ok = () => vi.fn(async () => new Response(JSON.stringify(config('host.docker.internal:10255'))));
  const none = async () => [];

  it('warns for a remote gateway that hands out the default proxy', async () => {
    const res = await checkRemoteProxy(GATEWAY, TOKEN, { fetchImpl: ok(), lookup: none, ownAddresses: own });
    expect(res.status).toBe('warn');
    expect(res.hint).toContain(gatewayRecreateCommand('192.168.107.212'));
  });

  it('passes a remote gateway that hands out its own address', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(config('192.168.107.212:10255'))));
    expect((await checkRemoteProxy(GATEWAY, TOKEN, { fetchImpl, lookup: none, ownAddresses: own })).status).toBe('ok');
  });

  it('passes a gateway on this machine without asking it anything', async () => {
    const fetchImpl = ok();
    for (const url of ['http://127.0.0.1:10254', 'http://172.17.0.1:10254']) {
      expect((await checkRemoteProxy(url, TOKEN, { fetchImpl, lookup: none, ownAddresses: own })).status).toBe('ok');
    }
    const local = async () => ['192.168.107.215'];
    const named = await checkRemoteProxy('http://nanoclaw.local:10254', TOKEN, {
      fetchImpl,
      lookup: local,
      ownAddresses: own,
    });
    expect(named.status).toBe('ok');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes a gateway bound to a docker bridge that is down, and still warns for a remote one', async () => {
    const fetchImpl = ok();
    const local = await checkRemoteProxy('http://172.17.0.1:10254', TOKEN, {
      fetchImpl,
      lookup: none,
      ownAddresses: linuxDownBridge(),
    });
    expect(local.status).toBe('ok');
    expect(fetchImpl).not.toHaveBeenCalled();
    const remote = await checkRemoteProxy(GATEWAY, TOKEN, {
      fetchImpl: ok(),
      lookup: none,
      ownAddresses: linuxDownBridge(),
    });
    expect(remote.status).toBe('warn');
  });

  it('skips when the config cannot be read, and survives a failed lookup', async () => {
    const refused = vi.fn(async () => new Response('', { status: 401 }));
    const skipped = await checkRemoteProxy(GATEWAY, TOKEN, { fetchImpl: refused, lookup: none, ownAddresses: own });
    expect(skipped.status).toBe('skipped');
    expect(skipped.hint).toContain('status 401');
    const lookup = async () => {
      throw new Error('ENOTFOUND');
    };
    expect((await checkRemoteProxy(GATEWAY, TOKEN, { fetchImpl: ok(), lookup, ownAddresses: own })).status).toBe(
      'warn',
    );
  });
});

describe('gatewayRecreateCommand', () => {
  // Runs the command for real against a stub docker, in a scratch HOME.
  // loadsEnv: whether the compose file passes ~/.onecli/.env into the container
  // (the 1.45 installer's does; older layouts load only ../.env).
  function runRecreate(
    docker: { image?: string; gw?: string; app?: string; loadsEnv?: boolean },
    env = 'POSTGRES_PASSWORD=pw',
    runs = 1,
  ) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-recreate-'));
    try {
      fs.mkdirSync(path.join(home, '.onecli'));
      fs.mkdirSync(path.join(home, 'bin'));
      fs.writeFileSync(path.join(home, '.onecli', '.env'), env);
      const log = path.join(home, 'compose.log');
      const stub = [
        '#!/bin/sh',
        'case "$1" in',
        `  inspect) ${docker.image ? `echo '${docker.image}'` : 'exit 1'} ;;`,
        `  port) [ "$3" = 10255/tcp ] && printf '${docker.gw ?? ''}' || printf '${docker.app ?? ''}' ;;`,
        `  exec) ${docker.loadsEnv === false ? 'true' : 'sed -n \'s/^GATEWAY_BASE_URL=//p\' "$HOME/.onecli/.env" | tail -n1'} ;;`,
        `  *) echo "$* | $ONECLI_VERSION $ONECLI_BIND_HOST $ONECLI_GATEWAY_PORT $ONECLI_APP_PORT" > '${log}' ;;`,
        'esac',
      ].join('\n');
      fs.writeFileSync(path.join(home, 'bin', 'docker'), stub, { mode: 0o755 });
      let res = spawnSync('/bin/true', { encoding: 'utf-8' });
      for (let i = 0; i < runs; i++) {
        res = spawnSync('/bin/sh', ['-c', gatewayRecreateCommand('192.168.107.212')], {
          encoding: 'utf-8',
          env: { PATH: `${path.join(home, 'bin')}:${process.env.PATH}`, HOME: home },
        });
      }
      return {
        status: res.status,
        stderr: res.stderr,
        env: fs.readFileSync(path.join(home, '.onecli', '.env'), 'utf-8'),
        compose: fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim() : null,
      };
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  it('saves the published gateway port and recreates onecli alone as it runs', () => {
    const res = runRecreate({
      image: 'ghcr.io/onecli/onecli:1.45.0',
      gw: '0.0.0.0:11255\\n[::]:11255\\n',
      app: '0.0.0.0:11254\\n',
    });
    expect(res.status).toBe(0);
    // A last line without a newline is not glued to the new one.
    expect(res.env).toBe('POSTGRES_PASSWORD=pw\nGATEWAY_BASE_URL=192.168.107.212:11255\n');
    expect(res.compose).toBe('compose up -d --no-deps onecli | 1.45.0 0.0.0.0 11255 11254');
  });

  it('keeps .env and the new copy, and says where, when the final step fails', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-recreate-full-'));
    try {
      fs.mkdirSync(path.join(home, '.onecli'));
      fs.mkdirSync(path.join(home, 'bin'));
      fs.writeFileSync(path.join(home, '.onecli', '.env'), 'POSTGRES_PASSWORD=pw\n');
      fs.writeFileSync(
        path.join(home, 'bin', 'docker'),
        [
          '#!/bin/sh',
          'case "$1" in',
          "  inspect) echo 'ghcr.io/onecli/onecli:1.45.0' ;;",
          '  port) [ "$3" = 10255/tcp ] && echo 10.0.0.5:10255 || echo 10.0.0.5:10254 ;;',
          '  *) exit 0 ;;',
          'esac',
        ].join('\n'),
        { mode: 0o755 },
      );
      // An mv that fails stands in for a full disk during the final step.
      fs.writeFileSync(path.join(home, 'bin', 'mv'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const res = spawnSync('/bin/sh', ['-c', gatewayRecreateCommand('192.168.107.212')], {
        encoding: 'utf-8',
        env: { PATH: `${path.join(home, 'bin')}:${process.env.PATH}`, HOME: home },
      });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('its full new contents are in');
      expect(fs.readFileSync(path.join(home, '.onecli', '.env'), 'utf-8')).toBe('POSTGRES_PASSWORD=pw\n');
      const kept = fs.readdirSync(path.join(home, '.onecli')).filter((f) => f.startsWith('.env.'));
      expect(kept).toHaveLength(1);
      expect(fs.readFileSync(path.join(home, '.onecli', kept[0]), 'utf-8')).toBe(
        'POSTGRES_PASSWORD=pw\nGATEWAY_BASE_URL=192.168.107.212:10255\n',
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('replaces an earlier GATEWAY_BASE_URL line where it stands instead of adding another', () => {
    const res = runRecreate(
      { image: 'ghcr.io/onecli/onecli:1.45.0', gw: '10.0.0.5:10255', app: '10.0.0.5:10254' },
      'POSTGRES_PASSWORD=pw\nGATEWAY_BASE_URL=old:1\nAFTER=${GATEWAY_BASE_URL}\n',
      2,
    );
    expect(res.status).toBe(0);
    expect(res.env).toBe('POSTGRES_PASSWORD=pw\nGATEWAY_BASE_URL=192.168.107.212:10255\nAFTER=${GATEWAY_BASE_URL}\n');
  });

  // Root reads a mode-0200 file anyway, so this only means something unprivileged.
  it.skipIf(process.getuid?.() === 0)(
    'leaves .env alone when it cannot read it, and leaves no temp file behind',
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-recreate-ro-'));
      try {
        fs.mkdirSync(path.join(home, '.onecli'));
        fs.mkdirSync(path.join(home, 'bin'));
        const envFile = path.join(home, '.onecli', '.env');
        fs.writeFileSync(envFile, 'POSTGRES_PASSWORD=pw\n');
        fs.chmodSync(envFile, 0o200);
        fs.writeFileSync(
          path.join(home, 'bin', 'docker'),
          [
            '#!/bin/sh',
            'case "$1" in',
            "  inspect) echo 'ghcr.io/onecli/onecli:1.45.0' ;;",
            '  port) [ "$3" = 10255/tcp ] && echo 10.0.0.5:10255 || echo 10.0.0.5:10254 ;;',
            '  *) exit 0 ;;',
            'esac',
          ].join('\n'),
          { mode: 0o755 },
        );
        const res = spawnSync('/bin/sh', ['-c', gatewayRecreateCommand('192.168.107.212')], {
          encoding: 'utf-8',
          env: { PATH: `${path.join(home, 'bin')}:${process.env.PATH}`, HOME: home },
        });
        fs.chmodSync(envFile, 0o600);
        expect(res.status).not.toBe(0);
        expect(fs.readFileSync(envFile, 'utf-8')).toBe('POSTGRES_PASSWORD=pw\n');
        expect(fs.readdirSync(path.join(home, '.onecli'))).toEqual(['.env']);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it('fails loudly when the value does not reach the container', () => {
    const res = runRecreate({
      image: 'ghcr.io/onecli/onecli:1.45.0',
      gw: '10.0.0.5:10255',
      app: '10.0.0.5:10254',
      loadsEnv: false,
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('environment:');
    expect(res.stderr).toContain('GATEWAY_BASE_URL');
  });

  it('keeps a digest-pinned tag whole', () => {
    const res = runRecreate({
      image: 'ghcr.io/onecli/onecli:1.45.0@sha256:abc',
      gw: '10.0.0.5:10255',
      app: '10.0.0.5:10254',
    });
    expect(res.compose).toBe('compose up -d --no-deps onecli | 1.45.0@sha256:abc 10.0.0.5 10255 10254');
  });

  it('leaves an unpinned gateway alone even with a pin in .env, which may be stale', () => {
    const res = runRecreate(
      { image: 'ghcr.io/onecli/onecli:latest', gw: '10.0.0.5:10255', app: '10.0.0.5:10254' },
      'ONECLI_VERSION=1.42.0\n',
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('onecli-upgrades.md');
    expect(res.env).toBe('ONECLI_VERSION=1.42.0\n');
    expect(res.compose).toBeNull();
  });

  it('keeps a digest pin on any tag', () => {
    const res = runRecreate({
      image: 'ghcr.io/onecli/onecli:latest@sha256:abc',
      gw: '10.0.0.5:10255',
      app: '10.0.0.5:10254',
    });
    expect(res.compose).toBe('compose up -d --no-deps onecli | latest@sha256:abc 10.0.0.5 10255 10254');
  });

  it('changes nothing for an unpinned tag, which compose would pull anew', () => {
    for (const image of ['ghcr.io/onecli/onecli:latest', 'ghcr.io/onecli/onecli:1.45']) {
      const res = runRecreate({ image, gw: '10.0.0.5:10255', app: '10.0.0.5:10254' });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('not a pinned release');
      expect(res.env).toBe('POSTGRES_PASSWORD=pw');
      expect(res.compose).toBeNull();
    }
  });

  it('changes nothing when a read fails or the image is not the stock one', () => {
    for (const docker of [
      {},
      { image: 'registry.example/onecli:1.45.0', gw: '10.0.0.5:10255', app: '10.0.0.5:10254' },
      { image: 'ghcr.io/onecli/onecli:1.45.0', app: '10.0.0.5:10254' },
      { image: 'ghcr.io/onecli/onecli:1.45.0', gw: '10.0.0.5:10255' },
    ]) {
      const res = runRecreate(docker);
      expect(res.status).not.toBe(0);
      expect(res.env).toBe('POSTGRES_PASSWORD=pw');
      expect(res.compose).toBeNull();
    }
  });
});

describe('runtimeGateway', () => {
  it('reads the URL and key the way the runtime does: process env, then .env', () => {
    const saved = { ONECLI_URL: GATEWAY, ONECLI_API_KEY: 'saved' };
    expect(runtimeGateway({}, saved)).toEqual({ url: GATEWAY, apiKey: 'saved' });
    expect(runtimeGateway({ ONECLI_API_KEY: 'exported' }, saved).apiKey).toBe('exported');
    expect(runtimeGateway({}, {})).toEqual({ url: undefined, apiKey: undefined });
  });
});

describe('check-proxy entry', () => {
  const entry = path.resolve('.claude/skills/add-onecli/scripts/check-proxy.ts');
  const tsx = path.resolve('node_modules/.bin/tsx');

  function runIn(envFile: string | null, extra: NodeJS.ProcessEnv = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-proxy-'));
    try {
      if (envFile !== null) fs.writeFileSync(path.join(root, '.env'), envFile);
      const env = { ...process.env, ONECLI_URL: '', ONECLI_API_KEY: '', ...extra };
      return spawnSync(tsx, [entry], { cwd: root, env, encoding: 'utf-8' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it('prints exactly one JSON line and exits 0, even with debug logging on', () => {
    for (const [envFile, status] of [
      [null, 'skipped'],
      ['ONECLI_URL=http://127.0.0.1:10254\n', 'ok'],
      ['ONECLI_URL=http://nanoclaw-check.invalid:10254\n', 'skipped'],
      ['ONECLI_URL=not a url\n', 'skipped'],
    ] as const) {
      const res = runIn(envFile, { LOG_LEVEL: 'debug' });
      expect(res.status).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.status).toBe(status);
      expect(out.hint).toBeTruthy();
      expect(res.stdout.trim().split('\n')).toHaveLength(1);
    }
  });
});
