/**
 * Tests for the host-side Bridge setup in /add-proton-mail: the owner check
 * (one Bridge per checkout), the IMAP readiness probe, and the ordering and
 * stdout rules the SKILL.md / REMOVE.md / entrypoint steps rely on.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getInstallSlug } from '../../../../src/install-slug.js';

const skillDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(skillDir, '..', '..', '..');
const ownerCheck = join(skillDir, 'bridge', 'owner-check.sh');
const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
const remove = readFileSync(join(skillDir, 'REMOVE.md'), 'utf8');
const entrypoint = readFileSync(join(skillDir, 'bridge', 'entrypoint.sh'), 'utf8');

/** The environment the scripts see: no slug or label overrides leak in from the caller. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const k of [
    'NANOCLAW_PROJECT_ROOT',
    'PROJECT_ROOT',
    'NANOCLAW_INSTALL_ID',
    'PROTON_BRIDGE_NAME',
    'PROTON_BRIDGE_NETWORK',
  ]) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}

describe('owner-check.sh with a fake docker', () => {
  let bin: string;
  let callLog: string;
  const mine = getInstallSlug(repoRoot);

  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), 'pm-owner-'));
    callLog = join(bin, 'calls.log');
    // `docker <kind> inspect -f FMT NAME`: absent (exit 1) unless FAKE_<KIND> is
    // set, in which case it prints that value as the label.
    writeFileSync(
      join(bin, 'docker'),
      `#!/usr/bin/env bash
echo "$*" >> "${callLog}"
kind=$1
var="FAKE_\${kind^^}"
[[ -v $var ]] || exit 1
printf '%s\\n' "\${!var}"
`,
    );
    chmodSync(join(bin, 'docker'), 0o755);
  });
  afterAll(() => rmSync(bin, { recursive: true, force: true }));

  function run(extra: Record<string, string> = {}) {
    rmSync(callLog, { force: true });
    const r = spawnSync('bash', [ownerCheck], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: cleanEnv({ PATH: `${bin}:${process.env.PATH}`, ...extra }),
    });
    const calls = existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n') : [];
    return { ...r, calls };
  }

  it('the shell slug matches the TypeScript slug NanoClaw labels its own containers with', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`nanoclaw-install=${mine}\n`);
    expect(r.stderr).toBe('');
  });

  it('checks the container, volume and network, by their configured names', () => {
    const r = run({ PROTON_BRIDGE_NAME: 'pm-x', PROTON_BRIDGE_NETWORK: 'pm-net' });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([
      'container inspect -f {{ index .Config.Labels "nanoclaw-install" }} pm-x',
      'volume inspect -f {{ index .Labels "nanoclaw-install" }} pm-x',
      'network inspect -f {{ index .Labels "nanoclaw-install" }} pm-net',
    ]);
  });

  it.each([
    ['this checkout', () => mine],
    ['no label (an older version of the skill)', () => ''],
    ['no label, as Go templates print it', () => '<no value>'],
  ])('passes resources labelled with %s', (_name, label) => {
    const r = run({ FAKE_CONTAINER: label(), FAKE_VOLUME: label(), FAKE_NETWORK: label() });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`nanoclaw-install=${mine}\n`);
  });

  it.each(['container', 'volume', 'network'])("refuses another checkout's %s, printing nothing on stdout", (kind) => {
    const r = run({ [`FAKE_${kind.toUpperCase()}`]: 'deadbeef' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(`the ${kind} `);
    expect(r.stderr).toContain('install deadbeef');
    expect(r.stderr).toContain(`this one is ${mine}`);
  });

  it('a refusal stops a chained step before it touches anything', () => {
    const r = spawnSync('bash', ['-c', `label=$(bash ${ownerCheck}) && echo REACHED`], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: cleanEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_VOLUME: 'deadbeef' }),
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('REACHED');
  });
});

const hasDocker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!hasDocker)('owner-check.sh against real docker', () => {
  const name = `pm-owner-test-${process.pid}`;
  const cleanup = () => {
    spawnSync('docker', ['volume', 'rm', '-f', name], { stdio: 'ignore' });
    spawnSync('docker', ['network', 'rm', name], { stdio: 'ignore' });
  };
  afterAll(cleanup);

  const run = () =>
    spawnSync('bash', [ownerCheck], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: cleanEnv({ PROTON_BRIDGE_NAME: name, PROTON_BRIDGE_NETWORK: name }),
    });

  it('reads the labels docker actually stores', () => {
    cleanup();
    expect(run().status).toBe(0); // nothing exists yet
    for (const kind of ['volume', 'network']) {
      spawnSync('docker', [kind, 'create', name], { stdio: 'ignore' }); // unlabelled
      expect(run().status, `unlabelled ${kind}`).toBe(0);
      cleanup();
      spawnSync('docker', [kind, 'create', '--label', 'nanoclaw-install=deadbeef', name], { stdio: 'ignore' });
      const r = run();
      expect(r.status, `foreign ${kind}`).toBe(1);
      expect(r.stderr).toContain('install deadbeef');
      cleanup();
    }
  });
});

describe('IMAP readiness probe in SKILL.md', () => {
  const probe = skill.match(/node -e "([^"]+)"/)?.[1];
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  async function serve(onConnect: (sock: import('node:net').Socket) => void): Promise<number> {
    const server = createServer(onConnect);
    servers.push(server);
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    return (server.address() as import('node:net').AddressInfo).port;
  }

  /** Async: a blocking spawn would starve the in-process server of its event loop. */
  function runProbe(port: number): Promise<{ status: number | null; ms: number }> {
    const started = Date.now();
    const child = spawn(process.execPath, ['-e', probe!.replace('connect(1143,', `connect(${port},`)], {
      stdio: 'ignore',
    });
    const kill = setTimeout(() => child.kill(), 15_000);
    return new Promise((res) =>
      child.on('exit', (status) => {
        clearTimeout(kill);
        res({ status, ms: Date.now() - started });
      }),
    );
  }

  it('is in the skill and targets Bridge on loopback 1143', () => {
    expect(probe).toBeDefined();
    expect(probe).toContain("connect(1143,'127.0.0.1')");
    expect(skill).not.toMatch(/\btimeout \d/); // no GNU timeout (absent on macOS)
  });

  it('succeeds on the IMAP greeting', async () => {
    const port = await serve((s) => s.write('* OK [CAPABILITY IMAP4rev1] Proton Mail Bridge\r\n'));
    expect((await runProbe(port)).status).toBe(0);
  });

  it('fails on any other greeting', async () => {
    const port = await serve((s) => s.end('* BYE not ready\r\n'));
    expect((await runProbe(port)).status).toBe(1);
  });

  it('fails on a closed port', async () => {
    const port = await serve(() => {});
    await new Promise<void>((res) => servers.pop()!.close(() => res()));
    expect((await runProbe(port)).status).toBe(1);
  });

  it('fails within its 5 s bound when the socket accepts but stays silent (the forwarder before Bridge is up)', async () => {
    const port = await serve(() => {});
    const r = await runProbe(port);
    expect(r.status).toBe(1);
    expect(r.ms).toBeLessThan(9_000);
  }, 12_000);
});

describe('step ordering and stdout rules', () => {
  /** Shell commands of nc:run blocks in SKILL.md, and bash blocks in REMOVE.md. */
  const runBlocks = [...skill.matchAll(/```nc:run[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const removeBlocks = [...remove.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const touchesBridge = /docker (rm|stop|run -d|volume (create|rm)|network (create|rm))\b|docker volume create/;

  it('every step that creates, stops, replaces or removes Bridge resources runs the owner check first', () => {
    const touching = [...runBlocks, ...removeBlocks].filter(
      (b) => touchesBridge.test(b) && /nanoclaw-(proton-bridge|mail)/.test(b),
    );
    expect(touching.length).toBeGreaterThanOrEqual(4); // volume, stop, run, remove
    for (const block of touching) {
      const check = block.indexOf('owner-check.sh');
      expect(check, block).toBeGreaterThanOrEqual(0);
      expect(check, block).toBeLessThan(block.search(touchesBridge));
    }
  });

  it('new Bridge resources are created with the label', () => {
    const creating = runBlocks.join('\n');
    expect(creating).toMatch(/docker volume create --label "\$label" nanoclaw-proton-bridge/);
    expect(creating).toMatch(/docker network create --label "\$label" nanoclaw-mail/);
    expect(creating).toMatch(/docker run -d --name nanoclaw-proton-bridge --label "\$label"/);
  });

  it('the running Bridge is stopped before the interactive login, which no longer relies on pkill', () => {
    const stop = skill.indexOf('docker stop nanoclaw-proton-bridge');
    const init = skill.indexOf('nanoclaw-proton-bridge:latest init');
    expect(stop).toBeGreaterThan(0);
    expect(stop).toBeLessThan(init);
    expect(entrypoint).not.toMatch(/^\s*pkill/m);
  });

  it('the entrypoint prints nothing on stdout before the `secrets` dispatch', () => {
    const before = entrypoint.slice(0, entrypoint.indexOf('== "secrets"'));
    const writes = before.split('\n').filter((l) => /^\s*(echo|printf)\b/.test(l));
    expect(writes.length).toBeGreaterThan(0);
    for (const line of writes) expect(line, line).toMatch(/>&2\s*$/);
  });
});
