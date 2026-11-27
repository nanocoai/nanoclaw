/**
 * Tests for the host-side Bridge setup in /add-proton-mail: the owner check
 * (one Bridge per checkout), the IMAP readiness probe, and the ordering and
 * stdout rules the SKILL.md / REMOVE.md / entrypoint steps rely on.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
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
const KEY = 'nanoclaw-proton-owner';

/** The environment the scripts see: no slug, name or adopt overrides leak in from the caller. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const k of [
    'NANOCLAW_PROJECT_ROOT',
    'PROJECT_ROOT',
    'NANOCLAW_INSTALL_ID',
    'PROTON_BRIDGE_NAME',
    'PROTON_BRIDGE_NETWORK',
    'PROTON_BRIDGE_ADOPT',
  ]) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}

/** A scratch project root holding only what owner-check.sh reads: the slug helper and (optionally) .env. */
function scratchProject(): { root: string; slug: string; setEnvFile: (configured: boolean) => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pm-owner-root-')));
  mkdirSync(join(root, 'setup', 'lib'), { recursive: true });
  copyFileSync(join(repoRoot, 'setup', 'lib', 'install-slug.sh'), join(root, 'setup', 'lib', 'install-slug.sh'));
  const setEnvFile = (configured: boolean) => {
    if (configured) writeFileSync(join(root, '.env'), 'PROTON_MAIL_BRIDGE_PASSWORD=abcdefghijklmnopqrstuv\n');
    else rmSync(join(root, '.env'), { force: true });
  };
  return { root, slug: getInstallSlug(root), setEnvFile };
}

describe('owner-check.sh with a fake docker', () => {
  let bin: string;
  let callLog: string;
  let project: ReturnType<typeof scratchProject>;

  beforeAll(() => {
    project = scratchProject();
    bin = mkdtempSync(join(tmpdir(), 'pm-owner-bin-'));
    callLog = join(bin, 'calls.log');
    // `docker <kind> inspect -f FMT NAME`: "not found" (as docker words it)
    // unless FAKE_<KIND> is set, in which case it prints that value as the
    // label. FAKE_DOWN makes every call fail as an unreachable daemon does.
    // Plain bash 3 (macOS /bin/bash): no ${x^^}, no [[ -v ]].
    writeFileSync(
      join(bin, 'docker'),
      `#!/usr/bin/env bash
echo "$*" >> "${callLog}"
if [ -n "\${FAKE_DOWN:-}" ]; then echo "failed to connect to the docker API at unix:///var/run/docker.sock" >&2; exit 1; fi
kind=$(printf %s "$1" | tr a-z A-Z)
eval "isset=\\\${FAKE_$kind+x}; val=\\\${FAKE_$kind-}"
if [ -z "$isset" ]; then
  if [ "$1" = network ]; then echo "Error response from daemon: network $4 not found" >&2
  else echo "Error response from daemon: No such $1: $4" >&2; fi
  exit 1
fi
printf '%s\\n' "$val"
`,
    );
    chmodSync(join(bin, 'docker'), 0o755);
  });
  afterAll(() => {
    rmSync(bin, { recursive: true, force: true });
    rmSync(project.root, { recursive: true, force: true });
  });

  function run(extra: Record<string, string> = {}, cwd = project.root) {
    rmSync(callLog, { force: true });
    const r = spawnSync('bash', [ownerCheck], {
      cwd,
      encoding: 'utf8',
      env: cleanEnv({ PATH: `${bin}:${process.env.PATH}`, ...extra }),
    });
    const calls = existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n') : [];
    return { ...r, calls };
  }
  const all = (label: string) => ({
    FAKE_IMAGE: label,
    FAKE_CONTAINER: label,
    FAKE_VOLUME: label,
    FAKE_NETWORK: label,
  });

  it('prints the label to apply, with the slug src/install-slug.ts computes', () => {
    project.setEnvFile(false);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${KEY}=${project.slug}\n`);
    expect(r.stderr).toBe('');
  });

  it('never uses `nanoclaw-install`, which the host reaps from session-less containers at startup', () => {
    expect(readFileSync(ownerCheck, 'utf8')).not.toMatch(/^KEY=nanoclaw-install/m);
    expect(run().stdout).not.toContain('nanoclaw-install=');
  });

  it('agrees with src/install-slug.ts through a symlinked path and under NANOCLAW_INSTALL_ID', () => {
    const link = join(tmpdir(), `pm-owner-link-${process.pid}`);
    rmSync(link, { force: true });
    symlinkSync(project.root, link);
    try {
      expect(run({ PWD: link }, link).stdout).toBe(`${KEY}=${project.slug}\n`);
    } finally {
      rmSync(link, { force: true });
    }
    expect(run({ NANOCLAW_INSTALL_ID: 'prod-1' }).stdout).toBe(`${KEY}=prod-1\n`);
    const bad = run({ NANOCLAW_INSTALL_ID: 'Not Valid' });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe('');
  });

  it('checks the image, container, volume and network, by their configured names', () => {
    const r = run({ PROTON_BRIDGE_NAME: 'pm-x', PROTON_BRIDGE_NETWORK: 'pm-net' });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([
      `image inspect -f {{ index .Config.Labels "${KEY}" }} pm-x:latest`,
      `container inspect -f {{ index .Config.Labels "${KEY}" }} pm-x`,
      `volume inspect -f {{ index .Labels "${KEY}" }} pm-x`,
      `network inspect -f {{ index .Labels "${KEY}" }} pm-net`,
    ]);
  });

  it("passes resources labelled with this checkout's slug", () => {
    project.setEnvFile(false);
    expect(run(all(project.slug)).status).toBe(0);
  });

  it.each([
    ['empty', ''],
    ['as Go templates print a missing key', '<no value>'],
  ])(
    'passes unlabelled (%s) resources only when this checkout set Bridge up (.env holds its password)',
    (_name, label) => {
      project.setEnvFile(true);
      expect(run(all(label)).status).toBe(0);
      project.setEnvFile(false);
      const r = run(all(label));
      expect(r.status).toBe(3);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('predates ownership labels');
    },
  );

  it.each(['image', 'container', 'volume', 'network'])(
    "refuses another checkout's %s, printing nothing on stdout, even when .env is set up",
    (kind) => {
      project.setEnvFile(true);
      const r = run({ [`FAKE_${kind.toUpperCase()}`]: 'deadbeef' });
      expect(r.status).toBe(3);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain(`the ${kind} `);
      expect(r.stderr).toContain('install deadbeef');
      expect(r.stderr).toContain(`this one is ${project.slug}`);
      expect(r.stderr).toContain('PROTON_BRIDGE_ADOPT=1');
    },
  );

  it('PROTON_BRIDGE_ADOPT=1 takes over a Bridge whose owner is gone', () => {
    project.setEnvFile(false);
    const r = run({ ...all('deadbeef'), PROTON_BRIDGE_ADOPT: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${KEY}=${project.slug}\n`);
    expect(r.stderr).toContain('taking it over');
  });

  it('refuses when docker cannot be asked, instead of treating everything as absent', () => {
    const r = run({ FAKE_DOWN: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('cannot ask docker');
  });

  it('a refusal stops a chained step before it touches anything', () => {
    project.setEnvFile(false);
    const r = spawnSync('bash', ['-c', `label=$(bash ${ownerCheck}) && echo REACHED`], {
      cwd: project.root,
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
  const project = scratchProject();
  const cleanup = () => {
    spawnSync('docker', ['volume', 'rm', '-f', name], { stdio: 'ignore' });
    spawnSync('docker', ['network', 'rm', name], { stdio: 'ignore' });
  };
  afterAll(() => {
    cleanup();
    rmSync(project.root, { recursive: true, force: true });
  });

  const run = (extra: Record<string, string> = {}) =>
    spawnSync('bash', [ownerCheck], {
      cwd: project.root,
      encoding: 'utf8',
      env: cleanEnv({ PROTON_BRIDGE_NAME: name, PROTON_BRIDGE_NETWORK: name, ...extra }),
    });
  const create = (kind: string, label?: string) =>
    spawnSync('docker', [kind, 'create', ...(label ? ['--label', label] : []), name], { stdio: 'ignore' });

  it("reads the labels and 'not found' errors docker actually produces", () => {
    cleanup();
    project.setEnvFile(false);
    expect(run().status).toBe(0); // nothing exists yet: every kind reports "not found"
    for (const kind of ['volume', 'network']) {
      create(kind);
      expect(run().status, `unlabelled ${kind}, no .env`).toBe(3);
      project.setEnvFile(true);
      expect(run().status, `unlabelled ${kind}, .env set up`).toBe(0);
      project.setEnvFile(false);
      cleanup();
      create(kind, `${KEY}=${project.slug}`);
      expect(run().status, `own ${kind}`).toBe(0);
      cleanup();
      create(kind, `${KEY}=deadbeef`);
      const r = run();
      expect(r.status, `foreign ${kind}`).toBe(3);
      expect(r.stderr).toContain('install deadbeef');
      cleanup();
    }
  });

  it('refuses when the daemon is unreachable', () => {
    const r = run({ DOCKER_HOST: 'unix:///nonexistent/docker.sock' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('cannot ask docker');
  });
});

describe('IMAP readiness probe in SKILL.md', () => {
  const probe = skill.match(/node -e "([^"]+)"/)?.[1];
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  async function serve(onConnect: (sock: Socket) => void): Promise<number> {
    const server = createServer(onConnect);
    servers.push(server);
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    return (server.address() as AddressInfo).port;
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

  it('fails at once when the connection closes with no greeting (the forwarder before Bridge listens)', async () => {
    const port = await serve((s) => s.end());
    const r = await runProbe(port);
    expect(r.status).toBe(1);
    expect(r.ms).toBeLessThan(3_000);
  });

  it('fails on a closed port', async () => {
    const port = await serve(() => {});
    await new Promise<void>((res) => servers.pop()!.close(() => res()));
    expect((await runProbe(port)).status).toBe(1);
  });

  it('fails within its 5 s bound when the socket accepts but stays silent', async () => {
    const port = await serve(() => {});
    const r = await runProbe(port);
    expect(r.status).toBe(1);
    expect(r.ms).toBeLessThan(9_000);
  }, 12_000);
});

describe('step ordering and stdout rules', () => {
  /** Shell commands of nc:run blocks in SKILL.md, its manual bash blocks (troubleshooting), and REMOVE.md's. */
  const runBlocks = [...skill.matchAll(/```nc:run[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const manualBlocks = [...skill.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const removeBlocks = [...remove.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const touchesBridge = /docker (build|rmi|rm|stop|run -d|volume (create|rm)|network (create|rm))\b/;

  it('every step that builds, creates, stops, replaces or removes Bridge resources runs the owner check first', () => {
    const touching = [...runBlocks, ...manualBlocks, ...removeBlocks].filter(
      (b) => touchesBridge.test(b) && /nanoclaw-(proton-bridge|mail)/.test(b),
    );
    expect(touching.length).toBeGreaterThanOrEqual(6); // build, volume, stop, run, recovery, remove
    for (const block of touching) {
      const check = block.indexOf('owner-check.sh');
      expect(check, block).toBeGreaterThanOrEqual(0);
      expect(check, block).toBeLessThan(block.search(touchesBridge));
    }
  });

  it('new Bridge resources are created with the label', () => {
    const creating = runBlocks.join('\n');
    expect(creating).toMatch(/docker build --label "\$label" -t nanoclaw-proton-bridge:latest/);
    expect(creating).toMatch(/docker volume create --label "\$label" nanoclaw-proton-bridge/);
    expect(creating).toMatch(/docker network create --label "\$label" nanoclaw-mail/);
    expect(creating).toMatch(/docker run -d --name nanoclaw-proton-bridge --label "\$label"/);
  });

  it("REMOVE.md's refusal skips the removals without exiting the operator's shell", () => {
    const block = removeBlocks.find((b) => b.includes('owner-check.sh'))!;
    expect(block).not.toMatch(/\bexit\b/);
    expect(block).toMatch(/^if bash \S+owner-check\.sh >\/dev\/null; then\n[\s\S]*docker volume rm[\s\S]*\nfi\n$/);
  });

  it('the running Bridge is stopped before the interactive login, and the manual note starts it again', () => {
    const stop = skill.indexOf('docker stop nanoclaw-proton-bridge');
    const init = skill.indexOf('nanoclaw-proton-bridge:latest init');
    expect(stop).toBeGreaterThan(0);
    expect(stop).toBeLessThan(init);
    expect(skill).toMatch(
      /sign in again later, first run `docker stop [^`]+`, then this, then `docker start nanoclaw-proton-bridge`/,
    );
    expect(entrypoint).not.toMatch(/^\s*pkill/m);
  });

  it('REMOVE.md checks ownership before it edits .env: an unlabelled Bridge is ours only while .env has its password', () => {
    const check = remove.indexOf('owner-check.sh');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(remove.indexOf('`PROTON_MAIL_BRIDGE_PASSWORD`'));
    expect(check).toBeLessThan(remove.indexOf('rm -rf store/proton-mail'));
  });

  it('REMOVE.md tells the operator to stop when the check refuses, before .env loses the password', () => {
    const block = removeBlocks.find((b) => b.includes('owner-check.sh'))!;
    expect(block).toMatch(/\nelse\n\s*rc=\$\?\n\s*if \[ "\$rc" -eq 3 \]; then\n\s*echo "[^"]*Carry on with step 2\." >&2\n\s*else\n\s*echo "Bridge NOT removed[^"]*Stop here[^"]*" >&2\n\s*false\n/);
  });

  it('no setup command splices a value into double quotes: values go in single quotes, which the prompts refuse', () => {
    for (const block of runBlocks) expect(block, block).not.toMatch(/"\{\{/);
    expect(skill).toMatch(/nc:prompt owner_email[^\n]*validate:\^\[\^@\\s'\]\+@/);
    expect(skill).toContain("set -o pipefail; pnpm exec tsx .claude/skills/add-proton-mail/scripts/normalize-address.ts '{{owner_email}}' | sed -n 's/^.*NORMALIZED=//p'");
  });

  it('REMOVE.md lists the .env keys as text, not as a shell block', () => {
    for (const block of removeBlocks) expect(block).not.toMatch(/^PROTON_MAIL_/m);
    expect(remove).toMatch(/^- `PROTON_MAIL_BRIDGE_PASSWORD`$/m);
  });

  it('the entrypoint prints nothing on stdout before the `secrets` dispatch', () => {
    const before = entrypoint.slice(0, entrypoint.indexOf('== "secrets"'));
    const writes = before.split('\n').filter((l) => /^\s*(echo|printf)\b/.test(l));
    expect(writes.length).toBeGreaterThan(0);
    for (const line of writes) expect(line, line).toMatch(/>&2\s*$/);
  });
});

describe('bridge-secrets.sh with a fake vault', () => {
  const script = join(skillDir, 'bridge', 'bridge-secrets.sh');
  let dir: string;
  const user = (email: string, pass: string) => ({ PrimaryEmail: email, BridgePass: Buffer.from(pass).toString('base64') });
  function run(field: string, vault: unknown, account?: string) {
    const editor = join(dir, 'vault-editor');
    writeFileSync(join(dir, 'vault.json'), JSON.stringify(vault));
    writeFileSync(editor, `#!/bin/bash\ncat ${JSON.stringify(join(dir, 'vault.json'))}\n`);
    chmodSync(editor, 0o755);
    const env: NodeJS.ProcessEnv = { ...process.env, BRIDGE_VAULT_EDITOR: editor };
    delete env.PROTON_BRIDGE_ACCOUNT;
    if (account !== undefined) env.PROTON_BRIDGE_ACCOUNT = account;
    return spawnSync('bash', [script, field], { env, encoding: 'utf8' });
  }
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-secrets-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('one account: its password (unpadded base64) and its address, lowercased', () => {
    const vault = { Users: [user('Agent@Example.org', 'abcd')] };
    expect(run('password', vault).stdout).toBe('YWJjZA\n');
    expect(run('address', vault).stdout).toBe('agent@example.org\n');
  });

  it('several accounts: refuses to guess, naming them, unless PROTON_BRIDGE_ACCOUNT picks one', () => {
    const vault = { Users: [user('a@example.org', 'first-pass'), user('b@example.org', 'second-pass')] };
    const refused = run('password', vault);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toMatch(/several accounts: a@example\.org, b@example\.org/);
    expect(refused.stderr).toMatch(/PROTON_BRIDGE_ACCOUNT=.* to \.env/);
    expect(run('password', vault, 'B@example.org').stdout).toBe(
      `${Buffer.from('second-pass').toString('base64').replace(/=+$/, '')}\n`,
    );
    expect(run('address', vault, 'b@example.org').stdout).toBe('b@example.org\n');
  });

  it('an account with no primary address is still counted and shown as ?', () => {
    const r = run('password', { Users: [user('a@example.org', 'p'), { BridgePass: 'cQ' }] });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/several accounts: a@example\.org, \?/);
  });

  it('PROTON_BRIDGE_ACCOUNT naming no account in the vault is refused', () => {
    const r = run('password', { Users: [user('a@example.org', 'p')] }, 'c@example.org');
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });

  it('a vault reader that fails says so, rather than "not signed in"', () => {
    const editor = join(dir, 'failing-editor');
    writeFileSync(editor, '#!/bin/bash\necho "gpg: decryption failed" >&2\nexit 2\n');
    chmodSync(editor, 0o755);
    const r = spawnSync('bash', [script, 'password'], {
      env: { ...process.env, BRIDGE_VAULT_EDITOR: editor },
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/could not read Bridge's vault/);
    expect(r.stderr).not.toMatch(/signed in/);
  });

  it('an empty vault says the account is not signed in', () => {
    const r = run('password', { Users: [] });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/signed in/);
  });
});

describe('store-secrets.sh keeps the account choice in .env', () => {
  it('passes PROTON_BRIDGE_ACCOUNT from .env to the vault read when the shell has none', () => {
    const work = mkdtempSync(join(tmpdir(), 'store-secrets-'));
    try {
      const bin = join(work, 'bin');
      mkdirSync(bin);
      const seen = join(work, 'seen');
      // A fake docker: records the account it was given, answers the password
      // read, and fails the certificate read so the script stops there.
      writeFileSync(
        join(bin, 'docker'),
        `#!/bin/bash\nprintf '%s\\n' "\${PROTON_BRIDGE_ACCOUNT-unset}" >> ${JSON.stringify(seen)}\n` +
          `case "\${@: -1}" in password) echo AAAAAAAAAAAAAAAAAAAAAAAA ;; *) exit 1 ;; esac\n`,
      );
      chmodSync(join(bin, 'docker'), 0o755);
      // Quoted, with a Windows line ending: both are taken off.
      writeFileSync(join(work, '.env'), 'PROTON_BRIDGE_ACCOUNT="b@example.org"\r\n');
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
      delete env.PROTON_BRIDGE_ACCOUNT;
      spawnSync('bash', [join(skillDir, 'bridge', 'store-secrets.sh')], { cwd: work, env, encoding: 'utf8' });
      expect(readFileSync(seen, 'utf8').trim().split('\n')[0]).toBe('b@example.org');
      expect(readFileSync(join(work, '.env'), 'utf8')).toMatch(/^PROTON_MAIL_BRIDGE_PASSWORD=A{24}$/m);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('bridge-account.sh reads the account as a .env value', () => {
  const script = join(skillDir, 'bridge', 'bridge-account.sh');
  function read(envText: string, fromShell?: string) {
    const work = mkdtempSync(join(tmpdir(), 'bridge-account-'));
    try {
      writeFileSync(join(work, '.env'), envText);
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.PROTON_BRIDGE_ACCOUNT;
      if (fromShell !== undefined) env.PROTON_BRIDGE_ACCOUNT = fromShell;
      return spawnSync('bash', [script], { cwd: work, env, encoding: 'utf8' }).stdout;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  it.each([
    ['plain', 'PROTON_BRIDGE_ACCOUNT=b@example.org\n'],
    ['double-quoted', 'PROTON_BRIDGE_ACCOUNT="b@example.org"\n'],
    ['single-quoted', "PROTON_BRIDGE_ACCOUNT='b@example.org'\n"],
    ['trailing space and CRLF', 'PROTON_BRIDGE_ACCOUNT=b@example.org  \r\n'],
    ['the last of two lines', 'PROTON_BRIDGE_ACCOUNT=a@example.org\nPROTON_BRIDGE_ACCOUNT=b@example.org\n'],
  ])('%s', (_name, text) => {
    expect(read(text)).toBe('b@example.org\n');
  });
  it('drops an inline comment after an unquoted value, and keeps one inside quotes', () => {
    expect(read('PROTON_BRIDGE_ACCOUNT=b@example.org  # the main one\n')).toBe('b@example.org\n');
    expect(read('PROTON_BRIDGE_ACCOUNT=                      # setup only\n')).toBe('\n');
    expect(read('PROTON_BRIDGE_ACCOUNT="b@example.org" # main\n')).toBe('b@example.org\n');
  });
  it('keeps an unmatched quote, prints nothing when unset, and lets the shell win', () => {
    expect(read('PROTON_BRIDGE_ACCOUNT="b@example.org\n')).toBe('"b@example.org\n');
    expect(read('OTHER=1\n')).toBe('\n');
    expect(read('PROTON_BRIDGE_ACCOUNT=a@example.org\n', 'b@example.org')).toBe('b@example.org\n');
  });
});

describe('owner-check.sh without docker', () => {
  it('passes, printing the label: no Bridge resources can exist (REMOVE.md can finish)', () => {
    const bin = mkdtempSync(join(tmpdir(), 'no-docker-'));
    try {
      // Only what the script needs besides docker.
      for (const tool of ['bash', 'sha1sum', 'cut', 'grep', 'realpath', 'dirname', 'pwd', 'cat', 'printf']) {
        const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
        if (found.startsWith('/')) symlinkSync(found, join(bin, tool));
      }
      const r = spawnSync('bash', [ownerCheck], {
        cwd: repoRoot,
        env: { PATH: bin, NANOCLAW_INSTALL_ID: 'testslug' },
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(`${KEY}=testslug\n`);
      expect(r.stderr).toMatch(/docker is not installed/);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
