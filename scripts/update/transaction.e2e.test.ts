import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acknowledgeRequirement,
  cleanupUpdate,
  cutoverUpdate,
  finishUpdate,
  loadGatewayModules,
  loadState,
  prepareUpdate,
  pruneTransactions,
  rollbackUpdate,
  validateUpdate,
  type UpdateRuntime,
} from './transaction.js';
import { CUTOVER_STOP_CLI_TIMEOUT_MS, DRAIN_LIST_FORMAT, drainContainers, stopService } from './service.js';
import { getInstallSlug } from '../../src/install-slug.js';
import type { CommandRunner, ServiceHandle } from './service.js';

const roots: string[] = [];
let previousUpdateDir: string | undefined;

function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function exec(cwd: string, command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, rel: string, content: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commit(root: string, message: string): string {
  exec(root, 'git', ['add', '.']);
  exec(root, 'git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', message]);
  return exec(root, 'git', ['rev-parse', 'HEAD']);
}

interface Fixture {
  install: string;
  originalHead: string;
  upstreamHead: string;
}

function writeOnecliSkill(root: string, payload: string): void {
  write(
    root,
    '.claude/skills/add-onecli/gateway.json',
    '{"kind":"onecli","label":"OneCLI","description":"Gateway","default":true}\n',
  );
  write(
    root,
    '.claude/skills/add-onecli/SKILL.md',
    [
      '---',
      'name: add-onecli',
      'description: Test gateway extraction.',
      '---',
      '',
      '```nc:copy',
      'payload/src/gateway-providers/onecli.ts -> src/gateway-providers/onecli.ts',
      '```',
      '',
      '```nc:append to:src/gateway-providers/installed.ts',
      "import './onecli.js';",
      '```',
      '',
    ].join('\n'),
  );
  write(
    root,
    '.claude/skills/add-onecli/scripts/detect.ts',
    "import fs from 'node:fs'; console.log(fs.readFileSync('.env', 'utf8').includes('ONECLI_URL=') ? 'installed' : 'absent');\n",
  );
  write(root, '.claude/skills/add-onecli/payload/src/gateway-providers/onecli.ts', payload);
}

function createForkFixture(
  options: {
    breaking?: boolean;
    gatewayExtraction?: boolean;
    gatewayPayloadOnly?: boolean | 'other';
    otherSkillOnly?: boolean;
  } = {},
): Fixture {
  const seed = temp('nanoclaw-update-seed-');
  exec(seed, 'git', ['init', '-b', 'main']);
  write(seed, 'package.json', '{"name":"nanoclaw-test","version":"2.1.54"}\n');
  // Mirrors the shipped .gitignore: the bare `data` entry is what lets an
  // operator point the root at external storage with a symlink without
  // `assertClean` refusing the cutover. `.tmp-*` covers restore leftovers.
  write(seed, '.gitignore', 'data/\ndata\n.env\nstart-nanoclaw.sh\nnanoclaw.pid\n.tmp-*\n');
  write(seed, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
  write(seed, 'src/channels/index.ts', "import './cli.js';\n");
  write(seed, 'src/providers/index.ts', '');
  write(seed, 'container/agent-runner/src/providers/index.ts', "import './claude.js';\n");
  write(seed, 'versions.json', '{"agent-image":"example@sha256:old"}\n');
  write(seed, 'CHANGELOG.md', '# Changelog\n');
  write(seed, 'src/value.ts', 'export const value = "old";\n');
  if (options.gatewayPayloadOnly) {
    writeOnecliSkill(seed, "export const gateway = 'onecli-v1';\n");
    write(seed, 'src/gateway-providers/installed.ts', "// Installed gateway providers.\nimport './onecli.js';\n");
    write(seed, 'src/gateway-providers/onecli.ts', "export const gateway = 'onecli-v1';\n");
    write(
      seed,
      '.claude/skills/add-other/gateway.json',
      '{"kind":"other","label":"Other","description":"Gateway","default":false}\n',
    );
    write(
      seed,
      '.claude/skills/add-other/SKILL.md',
      '---\nname: add-other\n---\n\n```nc:copy\npayload/other.ts -> src/gateway-providers/other.ts\n```\n',
    );
    write(seed, '.claude/skills/add-other/payload/other.ts', "export const gateway = 'other-v1';\n");
  }
  commit(seed, 'base');

  const official = temp('nanoclaw-update-official-');
  fs.rmSync(official, { recursive: true });
  exec(path.dirname(official), 'git', ['clone', '--bare', seed, official]);
  const fork = temp('nanoclaw-update-fork-');
  fs.rmSync(fork, { recursive: true });
  exec(path.dirname(fork), 'git', ['clone', '--bare', official, fork]);

  // A payload-only upstream change touches nothing outside the skill directory.
  if (options.gatewayPayloadOnly === 'other') {
    write(seed, '.claude/skills/add-other/payload/other.ts', "export const gateway = 'other-v2';\n");
  } else if (options.gatewayPayloadOnly) {
    write(
      seed,
      '.claude/skills/add-onecli/payload/src/gateway-providers/onecli.ts',
      "export const gateway = 'onecli-v2';\n",
    );
  } else if (options.otherSkillOnly) {
    write(seed, '.claude/skills/customize/SKILL.md', '---\nname: customize\n---\n');
  } else {
    write(seed, 'src/value.ts', 'export const value = "new";\n');
  }
  if (options.breaking) {
    fs.appendFileSync(
      path.join(seed, 'CHANGELOG.md'),
      '- [BREAKING] Test schema migration. Follow [the guide](docs/test-migration.md).\n',
    );
    write(seed, 'docs/test-migration.md', '# Test migration\n');
  }
  if (options.gatewayExtraction) {
    write(seed, 'src/gateway-providers/installed.ts', '// Installed gateway providers.\n');
    writeOnecliSkill(seed, "export const gateway = 'onecli';\n");
  }
  const upstreamHead = commit(seed, 'upstream update at same package version');
  exec(seed, 'git', ['remote', 'add', 'publish', official]);
  exec(seed, 'git', ['push', 'publish', 'main']);

  const install = temp('nanoclaw-update-install-');
  fs.rmSync(install, { recursive: true });
  exec(path.dirname(install), 'git', ['clone', fork, install]);
  exec(install, 'git', ['config', 'user.name', 'Test']);
  exec(install, 'git', ['config', 'user.email', 'test@example.com']);
  exec(install, 'git', ['remote', 'add', 'upstream', official]);
  exec(install, 'git', ['fetch', 'upstream']);
  write(install, 'local-customization.txt', 'keep me\n');
  const originalHead = commit(install, 'local customization');
  write(install, 'data/v2.db', 'old-schema');
  write(install, '.env', 'EXAMPLE=old\n');
  if (options.gatewayExtraction) fs.appendFileSync(path.join(install, '.env'), 'ONECLI_URL=http://127.0.0.1:10254\n');
  if (options.gatewayPayloadOnly) fs.appendFileSync(path.join(install, '.env'), 'NANOCLAW_GATEWAY_PROVIDER=onecli\n');
  write(install, 'start-nanoclaw.sh', '#!/bin/bash\nnode dist/index.js\n');
  write(install, 'nanoclaw.pid', '1234\n');
  return { install, originalHead, upstreamHead };
}

function fakeRuntime(
  install: string,
  options: { health?: boolean[]; migrateOnStart?: boolean } = {},
): { runtime: UpdateRuntime; events: string[] } {
  const events: string[] = [];
  const health = [...(options.health ?? [true])];
  const service: ServiceHandle = { mode: 'systemd-user', active: true, name: 'nanoclaw-test' };

  const runner: CommandRunner = {
    run(command, args, cwd = install) {
      if (command === 'git') return exec(cwd, command, args);
      events.push(`${command} ${args.join(' ')}`);
      if (command === 'pnpm' && args.includes('upgrade-state.ts')) {
        const head = exec(cwd, 'git', ['rev-parse', 'HEAD']);
        write(cwd, 'data/upgrade-state.json', JSON.stringify({ version: '2.1.54', commit: head, tree: 'test' }));
      }
      return '';
    },
    tryRun(command, args, cwd = install) {
      if (command === 'git') {
        try {
          return { ok: true, stdout: exec(cwd, command, args) };
        } catch (err) {
          return { ok: false, stdout: (err as { stdout?: Buffer }).stdout?.toString().trim() ?? '' };
        }
      }
      if (command === 'bun' && args[0] === '--version') return { ok: false, stdout: '' };
      return { ok: true, stdout: '' };
    },
  };

  const runtime: UpdateRuntime = {
    runner,
    serviceEnv: {
      platform: 'linux',
      home: os.homedir(),
      uid: process.getuid?.() ?? 0,
      runner,
      sleep: async () => {},
    },
    detectService: () => service,
    stopService: async (handle) => {
      if (handle.mode === 'unmanaged') throw new Error('refusing unmanaged service');
      events.push('service stop');
    },
    drainContainers: async () => {
      events.push('containers drained');
    },
    restartGateways: () => {
      events.push('gateways restarted');
    },
    // The fixtures are minimal repos with no setup/ tree; load this checkout's.
    loadGateway: () => loadGatewayModules(path.resolve(import.meta.dirname, '../..')),
    startService: () => {
      events.push('service start');
      if (options.migrateOnStart && fs.readFileSync(path.join(install, 'src/value.ts'), 'utf8').includes('new')) {
        fs.writeFileSync(path.join(install, 'data/v2.db'), 'forward-migrated-schema');
      }
    },
    verifyHealth: async () => health.shift() ?? true,
  };
  return { runtime, events };
}

// PATH stubs that record the pnpm, systemctl and docker calls a printed
// recovery chain makes; `docker ps` lists one gateway container.
function stubCommands(): { env: NodeJS.ProcessEnv; calls: () => string[] } {
  const bin = temp('nanoclaw-update-stubs-');
  const log = path.join(bin, 'calls.log');
  write(
    bin,
    'stub',
    '#!/bin/sh\nprintf \'%s\\n\' "$(basename "$0") $*" >> "$STUB_CALLS"\n' +
      'if [ "$(basename "$0")" = docker ] && [ "$1" = ps ]; then echo gw1; fi\n',
  );
  fs.chmodSync(path.join(bin, 'stub'), 0o755);
  for (const name of ['pnpm', 'systemctl', 'docker']) fs.symlinkSync('stub', path.join(bin, name));
  return {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, STUB_CALLS: log },
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
  };
}

function recoveryChain(message: string): string {
  const chain = message.split('(safe to run again if a step fails):\n')[1] ?? '';
  return chain.split('\nWhen it succeeds, start NanoClaw: ')[0];
}

function failSnapshotCopy(file: string): void {
  const copyFile = fs.copyFileSync;
  vi.spyOn(fs, 'copyFileSync').mockImplementation((source, destination, mode) => {
    if (String(source).endsWith(path.join('snapshot', file))) {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
    copyFile(source, destination, mode);
  });
}

afterEach(() => {
  if (previousUpdateDir === undefined) delete process.env.NANOCLAW_UPDATE_DIR;
  else process.env.NANOCLAW_UPDATE_DIR = previousUpdateDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('update-nanoclaw transaction end to end', () => {
  it('applies an implicit OneCLI skill before stamping the extracted gateway selection', async () => {
    const fixture = createForkFixture({ gatewayExtraction: true });
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const bin = temp('nanoclaw-update-bin-');
    const pnpm = path.join(bin, 'pnpm');
    // Runs the detector script, the last argument of `pnpm --silent exec tsx <script>`.
    write(bin, 'pnpm', `#!/bin/sh\nfor script; do :; done\nexec ${JSON.stringify(process.execPath)} "$script"\n`);
    fs.chmodSync(pnpm, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
    const { runtime, events } = fakeRuntime(fixture.install);
    const loadGateway = runtime.loadGateway;
    runtime.loadGateway = (root) => {
      events.push('gateway loaded');
      return loadGateway(root);
    };

    try {
      let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
      state = await validateUpdate(fixture.install, state.id, runtime);
      const beforeCutover = events.length;
      state = await cutoverUpdate(fixture.install, state.id, runtime);

      expect(state.phase).toBe('cutover');
      // tsx compiles each import with the esbuild it started with, and the install can replace it.
      const cutover = events.slice(beforeCutover);
      expect(cutover).toContain('gateway loaded');
      expect(cutover.indexOf('gateway loaded')).toBeLessThan(cutover.indexOf('pnpm install --frozen-lockfile'));
      expect(fs.readFileSync(path.join(fixture.install, 'src/gateway-providers/installed.ts'), 'utf8')).toContain(
        "import './onecli.js';",
      );
      expect(fs.readFileSync(path.join(fixture.install, 'src/gateway-providers/onecli.ts'), 'utf8')).toContain(
        "gateway = 'onecli'",
      );
      expect(fs.readFileSync(path.join(fixture.install, '.env'), 'utf8')).toContain('NANOCLAW_GATEWAY_PROVIDER=onecli');
      state = await finishUpdate(fixture.install, state.id, runtime);
      expect(state.phase).toBe('complete');
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it('refreshes the installed gateway when only its skill payload changed', async () => {
    const fixture = createForkFixture({ gatewayPayloadOnly: true });
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const { runtime } = fakeRuntime(fixture.install);

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    expect(state.changedFiles).toEqual(['.claude/skills/add-onecli/payload/src/gateway-providers/onecli.ts']);
    state = await validateUpdate(fixture.install, state.id, runtime);
    expect(state.skillRefresh?.selected).toEqual(['onecli']);
    state = await cutoverUpdate(fixture.install, state.id, runtime);

    expect(fs.readFileSync(path.join(fixture.install, 'src/gateway-providers/onecli.ts'), 'utf8')).toContain(
      "gateway = 'onecli-v2'",
    );
    const installed = fs.readFileSync(path.join(fixture.install, 'src/gateway-providers/installed.ts'), 'utf8');
    expect(installed.match(/onecli\.js/g)).toHaveLength(1);
    state = await finishUpdate(fixture.install, state.id, runtime);
    expect(state.phase).toBe('complete');
  });

  it('skips a payload-only gateway refresh when the install has no gateway selected', async () => {
    const fixture = createForkFixture({ gatewayPayloadOnly: true });
    write(fixture.install, '.env', 'EXAMPLE=old\n');
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const { runtime } = fakeRuntime(fixture.install);

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    expect(state.phase).toBe('validated');
    expect(state.gatewaySelection).toBeUndefined();
    expect(state.skillRefresh?.selected).toEqual([]);
    expect(state.validation?.[0]).toMatch(/^gateway payload refresh skipped: /);
  });

  it("leaves the selected gateway alone when only another gateway's payload changed", async () => {
    const fixture = createForkFixture({ gatewayPayloadOnly: 'other' });
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const { runtime } = fakeRuntime(fixture.install);

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    expect(state.phase).toBe('validated');
    expect(state.gatewaySelection).toBeUndefined();
    expect(state.skillRefresh?.selected).toEqual([]);
  });

  it('reports a payload-only skip when the selected gateway is not in the catalog', async () => {
    const fixture = createForkFixture({ gatewayPayloadOnly: true });
    write(fixture.install, '.env', 'NANOCLAW_GATEWAY_PROVIDER=custom-gateway\n');
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const { runtime } = fakeRuntime(fixture.install);

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    expect(state.phase).toBe('validated');
    expect(state.gatewaySelection).toBeUndefined();
    expect(state.validation?.[0]).toBe('gateway payload refresh skipped: Unknown gateway provider: custom-gateway');
  });

  it('leaves gateway handling alone when only a non-gateway skill changed', async () => {
    const fixture = createForkFixture({ otherSkillOnly: true });
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const { runtime } = fakeRuntime(fixture.install);
    runtime.loadGateway = () => Promise.reject(new Error('gateway modules must not load'));

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    expect(state.phase).toBe('validated');
    expect(state.gatewaySelection).toBeUndefined();
  });

  it('stages through official upstream, gates a migration, completes, and can restore code plus mutable state', async () => {
    const fixture = createForkFixture({ breaking: true });
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const { runtime, events } = fakeRuntime(fixture.install);

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    expect(state.phase).toBe('prepared');
    expect(state.targetHead).not.toBe(fixture.originalHead);
    expect(exec(fixture.install, 'git', ['rev-parse', 'HEAD'])).toBe(fixture.originalHead);

    state = await validateUpdate(fixture.install, state.id, runtime);
    expect(state.phase).toBe('validated');
    expect(state.skillRefresh?.success).toBe(true);

    state = await cutoverUpdate(fixture.install, state.id, runtime);
    expect(state.phase).toBe('cutover');
    expect(fs.readFileSync(path.join(fixture.install, 'src/value.ts'), 'utf8')).toContain('new');
    expect(fs.readFileSync(path.join(fixture.install, 'local-customization.txt'), 'utf8')).toBe('keep me\n');
    expect(state.requirements).toHaveLength(1);

    state = acknowledgeRequirement(fixture.install, state.id, state.requirements[0].id, 'succeeded', undefined);
    state = await finishUpdate(fixture.install, state.id, runtime);
    expect(state.phase).toBe('complete');
    expect(events).toContain('service start');

    const stageRoot = state.stageRoot;
    const stageBranch = state.stageBranch;
    state = cleanupUpdate(fixture.install, state.id, runtime);
    expect(state.stageCleanedAt).toBeTruthy();
    expect(fs.existsSync(stageRoot)).toBe(false);
    expect(() => exec(fixture.install, 'git', ['rev-parse', '--verify', stageBranch])).toThrow();
    expect(fs.existsSync(path.join(state.transactionRoot, 'snapshot'))).toBe(true);

    fs.writeFileSync(path.join(fixture.install, 'data/v2.db'), 'post-update-data');
    fs.writeFileSync(path.join(fixture.install, 'start-nanoclaw.sh'), '#!/bin/bash\nexit 1\n');
    fs.writeFileSync(path.join(fixture.install, 'nanoclaw.pid'), '9999\n');
    runtime.detectService = () => ({ mode: 'unmanaged', active: true });
    const beforeRollback = events.length;
    state = await rollbackUpdate(fixture.install, state.id, runtime);
    expect(state.phase).toBe('rolled-back');
    // Gateways kept through cutover must be remounted onto the restored data/.
    const rollbackEvents = events.slice(beforeRollback);
    expect(rollbackEvents).toContain('gateways restarted');
    expect(rollbackEvents.indexOf('gateways restarted')).toBeLessThan(rollbackEvents.indexOf('service start'));
    expect(exec(fixture.install, 'git', ['rev-parse', 'HEAD'])).toBe(fixture.originalHead);
    expect(fs.readFileSync(path.join(fixture.install, 'data/v2.db'), 'utf8')).toBe('old-schema');
    expect(fs.readFileSync(path.join(fixture.install, '.env'), 'utf8')).toBe('EXAMPLE=old\n');
    expect(fs.readFileSync(path.join(fixture.install, 'start-nanoclaw.sh'), 'utf8')).toBe(
      '#!/bin/bash\nnode dist/index.js\n',
    );
    expect(fs.readFileSync(path.join(fixture.install, 'nanoclaw.pid'), 'utf8')).toBe('1234\n');
  });

  it('snapshots and restores symlinked mutable roots without replacing the link', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const externalRoot = temp('nanoclaw-external-data-');
    const externalData = path.join(externalRoot, 'data');
    const dataLink = path.join(fixture.install, 'data');
    fs.renameSync(dataLink, externalData);
    const relativeTarget = path.relative(fixture.install, externalData);
    fs.symlinkSync(relativeTarget, dataLink);
    const { runtime } = fakeRuntime(fixture.install);

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);

    const snapshotData = path.join(state.transactionRoot, 'snapshot', 'data');
    expect(fs.lstatSync(snapshotData).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(snapshotData, 'v2.db'), 'utf8')).toBe('old-schema');
    expect(state.snapshot?.find((entry) => entry.relativePath === 'data')?.symlinkTarget).toBe(relativeTarget);

    fs.writeFileSync(path.join(externalData, 'v2.db'), 'forward-migrated-schema');
    state = await rollbackUpdate(fixture.install, state.id, runtime);

    expect(state.phase).toBe('rolled-back');
    expect(fs.lstatSync(dataLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(dataLink)).toBe(relativeTarget);
    expect(fs.readFileSync(path.join(externalData, 'v2.db'), 'utf8')).toBe('old-schema');
  });

  it('restores a symlinked root whose directory inode cannot be removed', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const externalRoot = temp('nanoclaw-external-data-');
    const externalData = path.join(externalRoot, 'data');
    const dataLink = path.join(fixture.install, 'data');
    fs.renameSync(dataLink, externalData);
    const relativeTarget = path.relative(fixture.install, externalData);
    fs.symlinkSync(relativeTarget, dataLink);
    const { runtime } = fakeRuntime(fixture.install);

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);
    fs.writeFileSync(path.join(externalData, 'v2.db'), 'forward-migrated-schema');

    // A read-only parent stands in for the mount point an operator would
    // realistically point `data` at: the children can go, the inode cannot.
    const externalDataInode = fs.statSync(externalData).ino;
    fs.chmodSync(externalRoot, 0o555);
    try {
      state = await rollbackUpdate(fixture.install, state.id, runtime);
    } finally {
      fs.chmodSync(externalRoot, 0o755);
    }

    expect(state.phase).toBe('rolled-back');
    expect(fs.readFileSync(path.join(externalData, 'v2.db'), 'utf8')).toBe('old-schema');
    // Restored in place: same directory, so ownership and ACLs survive too.
    expect(fs.statSync(externalData).ino).toBe(externalDataInode);
    expect(fs.readlinkSync(dataLink)).toBe(relativeTarget);
  });

  it('a failed cutover restores all of data/ even when it holds folders this user cannot delete (#4003)', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    // Rootful Docker creates nested mount points (extra/<name>) as root. A
    // read-only `extra` stands in for that: the host user cannot delete `mount`.
    const sessions = path.join(fixture.install, 'data/v2-sessions');
    const extra = path.join(sessions, 'ag-1/sess-1/extra');
    fs.mkdirSync(path.join(extra, 'mount'), { recursive: true });
    for (const group of ['ag-1', 'ag-2', 'ag-3']) write(sessions, `${group}/sess-1/inbound.db`, `${group} messages`);
    const { runtime, events } = fakeRuntime(fixture.install);
    const logs: string[] = [];
    runtime.serviceEnv.log = (message) => logs.push(message);
    // The target build fails after the snapshot, as #4004's did; by then the
    // live tree holds the undeletable folder and data the rollback must undo.
    const baseRun = runtime.runner.run.bind(runtime.runner);
    runtime.runner.run = (command, args, cwd = fixture.install) => {
      if (command === 'pnpm' && args[1] === 'build') {
        if (fs.readFileSync(path.join(fixture.install, 'src/value.ts'), 'utf8').includes('new')) {
          fs.writeFileSync(path.join(fixture.install, 'data/v2.db'), 'forward-migrated-schema');
          fs.chmodSync(extra, 0o555);
          throw new Error('target build failed');
        }
      }
      return baseRun(command, args, cwd);
    };
    const leftovers = () => fs.readdirSync(fixture.install).filter((name) => name.startsWith('.tmp-'));

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    try {
      await expect(cutoverUpdate(fixture.install, state.id, runtime)).rejects.toThrow('target build failed');

      expect(loadState(fixture.install, state.id).phase).toBe('rolled-back');
      expect(events.at(-1)).toBe('service start');
      expect(fs.readFileSync(path.join(fixture.install, 'data/v2.db'), 'utf8')).toBe('old-schema');
      for (const group of ['ag-1', 'ag-2', 'ag-3']) {
        expect(fs.readFileSync(path.join(sessions, `${group}/sess-1/inbound.db`), 'utf8')).toBe(`${group} messages`);
      }
      expect(fs.statSync(path.join(extra, 'mount')).isDirectory()).toBe(true);
      // Only the folder that could not be deleted is left, in a git-ignored
      // sibling the log names, so the next update still sees a clean tree.
      expect(leftovers()).toHaveLength(1);
      const leftover = path.join(fixture.install, leftovers()[0]);
      expect(fs.readdirSync(leftover)).toEqual(['v2-sessions']);
      expect(fs.readdirSync(path.join(leftover, 'v2-sessions'))).toEqual(['ag-1']);
      expect(fs.readdirSync(path.join(leftover, 'v2-sessions/ag-1/sess-1'))).toEqual(['extra']);
      expect(logs.join('\n')).toContain(`sudo rm -rf ${fs.realpathSync(leftover)}`);
      expect(exec(fixture.install, 'git', ['status', '--porcelain'])).toBe('');
    } finally {
      for (const name of leftovers()) {
        const locked = path.join(fixture.install, name, 'v2-sessions/ag-1/sess-1/extra');
        if (fs.existsSync(locked)) fs.chmodSync(locked, 0o755);
      }
      if (fs.existsSync(extra)) fs.chmodSync(extra, 0o755);
    }
  });

  it('a rollback that cannot copy the snapshot back touches no live file and says how to finish by hand', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const { runtime, events } = fakeRuntime(fixture.install);
    const baseRun = runtime.runner.run.bind(runtime.runner);
    runtime.runner.run = (command, args, cwd = fixture.install) => {
      if (command === 'pnpm' && args[1] === 'build') {
        if (fs.readFileSync(path.join(fixture.install, 'src/value.ts'), 'utf8').includes('new')) {
          fs.writeFileSync(path.join(fixture.install, 'data/v2.db'), 'forward-migrated-schema');
          // The disk fills up while the rollback copies the snapshot back.
          failSnapshotCopy(path.join('data', 'v2.db'));
          throw new Error('target build failed');
        }
      }
      return baseRun(command, args, cwd);
    };

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    let failure: Error | undefined;
    try {
      await cutoverUpdate(fixture.install, state.id, runtime);
    } catch (err) {
      failure = err as Error;
    } finally {
      vi.restoreAllMocks();
    }

    const snapshot = path.join(state.transactionRoot, 'snapshot');
    const message = failure?.message ?? '';
    expect(message).toContain('target build failed\nThe automatic rollback failed too: ');
    expect(message).toContain('Could not restore the mutable-state snapshot: ENOSPC');
    expect(message).toContain('Nothing was deleted');
    expect(message).toContain('NanoClaw is stopped');
    expect(message).toContain(`  cd ${state.projectRoot} &&\n  snapshot=${snapshot} &&\n`);
    expect(message).toMatch(
      /\n {2}move_aside data \.tmp-before-rollback-\w+-data && mkdir -p data && cp -af "\$snapshot"\/data\/\. data\/ &&\n/,
    );
    expect(loadState(fixture.install, state.id).lastError).toBe(message);
    // No live file was deleted or replaced, no copy was left behind, and the
    // service stays stopped rather than starting on a half-restored tree.
    expect(fs.readFileSync(path.join(fixture.install, 'data/v2.db'), 'utf8')).toBe('forward-migrated-schema');
    expect(fs.readdirSync(fixture.install).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
    expect(events.at(-1)).not.toBe('service start');
    expect(fs.readFileSync(path.join(snapshot, 'data/v2.db'), 'utf8')).toBe('old-schema');

    // The printed chain is fail-fast: a copy that fails starts nothing.
    const stubs = stubCommands();
    fs.chmodSync(path.join(snapshot, 'data/v2.db'), 0o000);
    try {
      expect(spawnSync('sh', ['-c', recoveryChain(message)], { env: stubs.env }).status).not.toBe(0);
    } finally {
      fs.chmodSync(path.join(snapshot, 'data/v2.db'), 0o644);
    }
    expect(stubs.calls()).toEqual([]);
    // Run again once the cause is gone, it finishes exactly what the rollback would have.
    expect(spawnSync('sh', ['-c', recoveryChain(message)], { env: stubs.env }).status).toBe(0);
    expect(fs.readFileSync(path.join(fixture.install, 'data/v2.db'), 'utf8')).toBe('old-schema');
    expect(fs.readFileSync(path.join(fixture.install, '.env'), 'utf8')).toBe('EXAMPLE=old\n');
    expect(stubs.calls()).toEqual([
      `docker ps -aq --filter label=nanoclaw-install=${getInstallSlug(state.projectRoot)} --filter label=nanoclaw-role=gateway`,
      'docker restart -t 10 gw1',
      'pnpm install --frozen-lockfile',
      'pnpm run build',
    ]);
    // The start is its own last step, never part of the re-runnable chain.
    expect(message).toMatch(/\nWhen it succeeds, start NanoClaw: .*systemctl --user start nanoclaw-test$/);
  });

  it('the printed recovery for a symlinked data/ restores into the same directory', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const externalData = path.join(temp('nanoclaw-external-data-'), 'data');
    const dataLink = path.join(fixture.install, 'data');
    fs.renameSync(dataLink, externalData);
    fs.symlinkSync(externalData, dataLink);
    const { runtime } = fakeRuntime(fixture.install);
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);
    state = await finishUpdate(fixture.install, state.id, runtime);
    fs.writeFileSync(path.join(externalData, 'v2.db'), 'post-update-data');

    failSnapshotCopy(path.join('data', 'v2.db'));
    let message = '';
    try {
      await rollbackUpdate(fixture.install, state.id, runtime).catch((err: Error) => {
        message = err.message;
      });
    } finally {
      vi.restoreAllMocks();
    }
    expect(message).toContain('Nothing was deleted');
    expect(fs.readFileSync(path.join(externalData, 'v2.db'), 'utf8')).toBe('post-update-data');

    // A copy that fails part way stops the chain; the same chain then re-runs.
    const inode = fs.statSync(externalData).ino;
    const snapshotDb = path.join(state.transactionRoot, 'snapshot', 'data', 'v2.db');
    fs.chmodSync(snapshotDb, 0o000);
    try {
      expect(spawnSync('sh', ['-c', recoveryChain(message)], { env: stubCommands().env }).status).not.toBe(0);
    } finally {
      fs.chmodSync(snapshotDb, 0o644);
    }
    expect(spawnSync('sh', ['-c', recoveryChain(message)], { env: stubCommands().env }).status).toBe(0);
    expect(fs.readFileSync(path.join(externalData, 'v2.db'), 'utf8')).toBe('old-schema');
    // The live children went into one held-aside folder; the directory itself stayed.
    // One fresh folder per run: the first holds what was live, the second the failed run's copy.
    const held = fs.readdirSync(externalData).filter((name) => name !== 'v2.db');
    expect(held).toHaveLength(2);
    expect(held.every((name) => /^\.tmp-before-rollback-\w+-\w{6}$/.test(name))).toBe(true);
    const before = held.map((name) => path.join(externalData, name, 'v2.db')).filter((file) => fs.existsSync(file));
    expect(before.map((file) => fs.readFileSync(file, 'utf8'))).toEqual(['post-update-data']);
    expect(fs.statSync(externalData).ino).toBe(inode);
    expect(fs.readlinkSync(dataLink)).toBe(externalData);
  });

  it('a target the rollback cannot read still gets restore steps ahead of the start command', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const externalData = path.join(temp('nanoclaw-external-data-'), 'data');
    fs.renameSync(path.join(fixture.install, 'data'), externalData);
    fs.symlinkSync(externalData, path.join(fixture.install, 'data'));
    const { runtime } = fakeRuntime(fixture.install);
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);
    state = await finishUpdate(fixture.install, state.id, runtime);

    fs.chmodSync(externalData, 0o000);
    let message = '';
    try {
      await rollbackUpdate(fixture.install, state.id, runtime).catch((err: Error) => {
        message = err.message;
      });
    } finally {
      fs.chmodSync(externalData, 0o755);
    }
    expect(message).toMatch(/Could not restore the mutable-state snapshot: EACCES/);
    const chain = recoveryChain(message);
    expect(chain.indexOf('cp -af "$snapshot"/data/.')).toBeGreaterThan(0);
    expect(message.indexOf('cp -af "$snapshot"/data/.')).toBeLessThan(message.indexOf('When it succeeds, start'));
  });

  it('the printed image step follows the .env being restored, not the unreadable live one', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const env = path.join(fixture.install, '.env');
    fs.writeFileSync(env, 'EXAMPLE=old\nNANOCLAW_HARDENED_IMAGE=true\n');
    const { runtime } = fakeRuntime(fixture.install);
    const baseRun = runtime.runner.run.bind(runtime.runner);
    runtime.runner.run = (command, args, cwd = fixture.install) => {
      if (command === 'pnpm' && args[1] === 'build') {
        if (fs.readFileSync(path.join(fixture.install, 'src/value.ts'), 'utf8').includes('new')) {
          fs.writeFileSync(env, 'EXAMPLE=new\n');
          fs.chmodSync(env, 0o000);
          failSnapshotCopy(path.join('data', 'v2.db'));
          throw new Error('target build failed');
        }
      }
      return baseRun(command, args, cwd);
    };
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    // A change under container/ makes cutover and rollback rebuild the image.
    write(state.stageRoot, 'container/Dockerfile', 'FROM scratch\n');
    commit(state.stageRoot, 'container change');
    state = await validateUpdate(fixture.install, state.id, runtime);
    let message = '';
    try {
      await cutoverUpdate(fixture.install, state.id, runtime).catch((err: Error) => {
        message = err.message;
      });
    } finally {
      vi.restoreAllMocks();
      fs.chmodSync(env, 0o644);
    }
    expect(message).toContain('Nothing was deleted');
    expect(recoveryChain(message)).toMatch(/ &&\n {2}bash container\/build\.sh pull$/);
    expect(fs.readFileSync(env, 'utf8')).toBe('EXAMPLE=new\n');
  });

  it('restores overlapping roots once: .env symlinked into the data/ target', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const externalData = path.join(temp('nanoclaw-external-data-'), 'data');
    fs.renameSync(path.join(fixture.install, 'data'), externalData);
    fs.symlinkSync(externalData, path.join(fixture.install, 'data'));
    fs.renameSync(path.join(fixture.install, '.env'), path.join(externalData, 'config.env'));
    fs.symlinkSync(path.join(externalData, 'config.env'), path.join(fixture.install, '.env'));
    const { runtime } = fakeRuntime(fixture.install);
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);
    state = await finishUpdate(fixture.install, state.id, runtime);
    fs.writeFileSync(path.join(externalData, 'config.env'), 'EXAMPLE=post-update\n');
    fs.writeFileSync(path.join(externalData, 'v2.db'), 'post-update-data');

    state = await rollbackUpdate(fixture.install, state.id, runtime);

    expect(state.phase).toBe('rolled-back');
    expect(fs.readFileSync(path.join(externalData, 'config.env'), 'utf8')).toBe('EXAMPLE=old\n');
    expect(fs.readFileSync(path.join(externalData, 'v2.db'), 'utf8')).toBe('old-schema');
    expect(fs.readdirSync(externalData).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
  });

  it('a restore that fails part way through the swap puts every live path back', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const { runtime } = fakeRuntime(fixture.install);
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);
    state = await finishUpdate(fixture.install, state.id, runtime);
    fs.writeFileSync(path.join(fixture.install, 'data/v2.db'), 'post-update-data');
    fs.writeFileSync(path.join(fixture.install, '.env'), 'EXAMPLE=post-update\n');

    // .env swaps first; then data/ is moved aside but its copy cannot move in.
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).includes('.tmp-restore-') && String(to) === path.join(state.projectRoot, 'data')) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      rename(from, to);
    });
    try {
      await expect(rollbackUpdate(fixture.install, state.id, runtime)).rejects.toThrow(
        /EBUSY[\s\S]*Nothing was deleted[\s\S]*NanoClaw is stopped/,
      );
    } finally {
      vi.restoreAllMocks();
    }

    expect(fs.readFileSync(path.join(fixture.install, '.env'), 'utf8')).toBe('EXAMPLE=post-update\n');
    expect(fs.readFileSync(path.join(fixture.install, 'data/v2.db'), 'utf8')).toBe('post-update-data');
    expect(fs.readdirSync(fixture.install).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
    expect(loadState(fixture.install, state.id).phase).toBe('complete');
  });

  it('fails closed before stopping the service when the snapshot is gone', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const { runtime, events } = fakeRuntime(fixture.install);

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);
    const headAfterCutover = exec(fixture.install, 'git', ['rev-parse', 'HEAD']);
    fs.rmSync(path.join(state.transactionRoot, 'snapshot'), { recursive: true, force: true });
    const stopsBefore = events.filter((event) => event === 'service stop').length;

    await expect(rollbackUpdate(fixture.install, state.id, runtime)).rejects.toThrow('Mutable-state snapshot missing');

    // Nothing was torn down: no extra stop, and the checkout is still at the
    // new head rather than reset to old code with a forward-migrated database.
    expect(events.filter((event) => event === 'service stop').length).toBe(stopsBefore);
    expect(exec(fixture.install, 'git', ['rev-parse', 'HEAD'])).toBe(headAfterCutover);
  });

  it('fails closed before restore when a mutable-root symlink changed after snapshot', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const externalRoot = temp('nanoclaw-external-data-');
    const externalData = path.join(externalRoot, 'data');
    const replacementData = path.join(externalRoot, 'replacement');
    const dataLink = path.join(fixture.install, 'data');
    fs.renameSync(dataLink, externalData);
    fs.mkdirSync(replacementData);
    fs.symlinkSync(path.relative(fixture.install, externalData), dataLink);
    const { runtime } = fakeRuntime(fixture.install);

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);
    fs.writeFileSync(path.join(fixture.install, '.env'), 'EXAMPLE=post-update\n');
    fs.unlinkSync(dataLink);
    fs.symlinkSync(path.relative(fixture.install, replacementData), dataLink);

    await expect(rollbackUpdate(fixture.install, state.id, runtime)).rejects.toThrow(
      'Mutable-state symlink changed after snapshot',
    );
    expect(fs.readFileSync(path.join(fixture.install, '.env'), 'utf8')).toBe('EXAMPLE=post-update\n');
    expect(fs.readlinkSync(dataLink)).toBe(path.relative(fixture.install, replacementData));
  });

  it('reports a dangling mutable-root symlink by name during validation', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const dataLink = path.join(fixture.install, 'data');
    fs.rmSync(dataLink, { recursive: true });
    fs.symlinkSync('../missing-nanoclaw-data', dataLink);
    const { runtime } = fakeRuntime(fixture.install);

    const state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);

    // Named up front, rather than a bare ENOENT after stop/drain has run.
    await expect(validateUpdate(fixture.install, state.id, runtime)).rejects.toThrow(
      /Mutable-state symlink points at a missing target:.*data -> \.\.\/missing-nanoclaw-data/,
    );
    const reloaded = loadState(fixture.install, state.id);
    expect(reloaded.phase).toBe('prepared');
    expect(reloaded.snapshot).toBeUndefined();
  });

  it('prunes only older terminal transactions and keeps the selected rollback point', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const { runtime } = fakeRuntime(fixture.install);

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);
    state = await finishUpdate(fixture.install, state.id, runtime);

    const oldId = '20000101000000-old';
    const oldRoot = path.join(process.env.NANOCLAW_UPDATE_DIR!, oldId);
    fs.mkdirSync(oldRoot, { recursive: true });
    fs.writeFileSync(
      path.join(oldRoot, 'state.json'),
      JSON.stringify({
        ...state,
        id: oldId,
        transactionRoot: oldRoot,
        phase: 'rolled-back',
        createdAt: '2000-01-01T00:00:00.000Z',
        stageRoot: path.join(oldRoot, 'worktree'),
        stageBranch: `update-nanoclaw/${oldId}`,
      }),
    );
    const pendingId = '20000101000001-pending';
    const pendingRoot = path.join(process.env.NANOCLAW_UPDATE_DIR!, pendingId);
    fs.mkdirSync(pendingRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pendingRoot, 'state.json'),
      JSON.stringify({
        ...state,
        id: pendingId,
        transactionRoot: pendingRoot,
        phase: 'prepared',
        createdAt: '2000-01-01T00:00:01.000Z',
        stageRoot: path.join(pendingRoot, 'worktree'),
        stageBranch: `update-nanoclaw/${pendingId}`,
      }),
    );
    const unsafeId = '20000101000002-unsafe';
    const unsafeRoot = path.join(process.env.NANOCLAW_UPDATE_DIR!, unsafeId);
    fs.mkdirSync(unsafeRoot, { recursive: true });
    fs.writeFileSync(
      path.join(unsafeRoot, 'state.json'),
      JSON.stringify({
        ...state,
        id: unsafeId,
        transactionRoot: unsafeRoot,
        phase: 'complete',
        createdAt: '2000-01-01T00:00:02.000Z',
        stageRoot: fixture.install,
        stageBranch: `update-nanoclaw/${unsafeId}`,
      }),
    );

    const preview = pruneTransactions(fixture.install, state.id, true, runtime);
    expect(preview.removed).toEqual([oldId]);
    expect(fs.existsSync(oldRoot)).toBe(true);

    const report = pruneTransactions(fixture.install, state.id, false, runtime);
    expect(report.removed).toEqual([oldId]);
    expect(fs.existsSync(oldRoot)).toBe(false);
    expect(fs.existsSync(pendingRoot)).toBe(true);
    expect(fs.existsSync(unsafeRoot)).toBe(true);
    expect(fs.existsSync(state.transactionRoot)).toBe(true);
  });

  it('automatically restores the old checkout and pre-migration DB when new-service health fails', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const { runtime } = fakeRuntime(fixture.install, { health: [false, true], migrateOnStart: true });

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);

    await expect(finishUpdate(fixture.install, state.id, runtime)).rejects.toThrow('health verification');
    expect(exec(fixture.install, 'git', ['rev-parse', 'HEAD'])).toBe(fixture.originalHead);
    expect(fs.readFileSync(path.join(fixture.install, 'data/v2.db'), 'utf8')).toBe('old-schema');
    expect(fs.existsSync(path.join(fixture.install, 'data/upgrade-state.json'))).toBe(false);
  });
  it('rolls back even though cutover already stopped the service (stale handle must not be re-stopped)', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const { runtime, events } = fakeRuntime(fixture.install);

    // A launchd-faithful RUNNER under the REAL stopService: `launchctl
    // bootout` of a not-loaded job fails with "Boot-out failed: 3: No such
    // process", exactly as it does live. The idempotency under test is
    // stopService's own contract, not a fake's.
    let running = true;
    const launchdRunner: CommandRunner = {
      run(command, args) {
        if (command === 'launchctl' && args[0] === 'bootout') {
          if (!running) {
            throw new Error(`Command failed: launchctl bootout ${args[1]}\nBoot-out failed: 3: No such process`);
          }
          running = false;
          events.push('service stop');
          return '';
        }
        if (command === 'launchctl' && args[0] === 'print' && !running) {
          throw Object.assign(new Error('Could not find service'), { status: 113 });
        }
        return '';
      },
      tryRun: () => ({ ok: true, stdout: '' }),
    };
    runtime.detectService = () => ({ mode: 'launchd', active: true, name: 'nanoclaw-test' });
    runtime.stopService = (handle) =>
      stopService(handle, {
        platform: 'darwin',
        home: os.homedir(),
        uid: 501,
        runner: launchdRunner,
        sleep: async () => {},
      });
    runtime.startService = () => {
      running = true;
      events.push('service start');
    };
    // Building the TARGET fails (post-reset tree contains 'new'); the
    // rollback's rebuild of the original tree succeeds.
    const baseRun = runtime.runner.run.bind(runtime.runner);
    runtime.runner.run = (command, args, cwd = fixture.install) => {
      if (command === 'pnpm' && args[1] === 'build') {
        if (fs.readFileSync(path.join(fixture.install, 'src/value.ts'), 'utf8').includes('new')) {
          throw new Error('target build failed');
        }
      }
      return baseRun(command, args, cwd);
    };

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    await expect(cutoverUpdate(fixture.install, state.id, runtime)).rejects.toThrow('target build failed');

    state = loadState(fixture.install, state.id);
    expect(state.phase).toBe('rolled-back');
    expect(exec(fixture.install, 'git', ['rev-parse', 'HEAD'])).toBe(fixture.originalHead);
    // Exactly one stop (cutover's own); the rollback re-detected a stopped
    // service instead of re-stopping the stale captured handle.
    expect(events.filter((event) => event === 'service stop')).toHaveLength(1);
    expect(events).toContain('service start');
    expect(running).toBe(true);
  });

  it('a rollback whose drain fails restarts the stopped service and changes nothing', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const { runtime, events } = fakeRuntime(fixture.install);
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);
    state = await finishUpdate(fixture.install, state.id, runtime);
    const updatedHead = exec(fixture.install, 'git', ['rev-parse', 'HEAD']);

    runtime.drainContainers = async () => {
      throw new Error('Cannot inspect active NanoClaw containers with docker');
    };
    events.length = 0;
    await expect(rollbackUpdate(fixture.install, state.id, runtime)).rejects.toThrow('Cannot inspect');
    expect(events).toEqual(['service stop', 'service start']);
    expect(loadState(fixture.install, state.id).phase).toBe('complete');
    expect(exec(fixture.install, 'git', ['rev-parse', 'HEAD'])).toBe(updatedHead);
  });

  it('a failed rollback drain never starts a service that was already down (after cutover, before finish)', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const { runtime, events } = fakeRuntime(fixture.install);
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);

    // Cutover left the service stopped; migrations may still be pending.
    runtime.detectService = () => ({ mode: 'systemd-user', active: false, name: 'nanoclaw-test' });
    runtime.drainContainers = async () => {
      throw new Error('Cannot inspect active NanoClaw containers with docker');
    };
    events.length = 0;
    await expect(rollbackUpdate(fixture.install, state.id, runtime)).rejects.toThrow('Cannot inspect');
    expect(events).not.toContain('service start');
    expect(loadState(fixture.install, state.id).phase).toBe('cutover');
  });

  it('nohup rollback stops the host started after cutover and drains containers before restoring data/', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const { runtime, events } = fakeRuntime(fixture.install);
    // Captured at cutover: the pre-update host, which cutover itself stops.
    const oldPid = spawnSync('node', ['-e', '']).pid;
    const definition = path.join(fixture.install, 'start-nanoclaw.sh');
    runtime.detectService = () => ({ mode: 'nohup', active: true, definition, pid: oldPid });
    runtime.stopService = async (handle) => {
      events.push(`service stop ${handle.pid}`);
      await stopService(handle, { ...runtime.serviceEnv, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    };
    const proc = temp('nanoclaw-update-proc-');
    runtime.serviceEnv.procRoot = proc;
    runtime.drainContainers = async (root) => {
      events.push(`containers drained (db=${fs.readFileSync(path.join(root, 'data/v2.db'), 'utf8')})`);
    };

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);
    state = await finishUpdate(fixture.install, state.id, runtime);
    expect(state.phase).toBe('complete');

    // finish's start-nanoclaw.sh launched a new host and recorded only its pid.
    const live = spawn('sleep', ['30'], { stdio: 'ignore' });
    const exited = new Promise((resolve) => live.once('exit', resolve));
    try {
      fs.writeFileSync(path.join(fixture.install, 'nanoclaw.pid'), `${live.pid}\n`);
      const entrypoint = path.join(fs.realpathSync(fixture.install), 'dist', 'index.js');
      write(proc, `${live.pid}/cmdline`, `node\0${entrypoint}\0`);
      fs.writeFileSync(path.join(fixture.install, 'data/v2.db'), 'post-update-data');
      events.length = 0;

      state = await rollbackUpdate(fixture.install, state.id, runtime);
      expect(state.phase).toBe('rolled-back');
      expect(events.slice(0, 2)).toEqual([`service stop ${live.pid}`, 'containers drained (db=post-update-data)']);
      await expect(exited).resolves.toBeDefined();
      expect(fs.readFileSync(path.join(fixture.install, 'data/v2.db'), 'utf8')).toBe('old-schema');
    } finally {
      live.kill('SIGKILL');
    }
  });

  it("cutover stops the install's containers only after the service is down, and a container that will not stop restores the old service (#3828)", async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const { runtime, events } = fakeRuntime(fixture.install);
    // The REAL drain under a docker-faithful runner: one idle agent container
    // that only disappears once `docker stop` has been issued for it.
    let stopIssued = false;
    const docker: CommandRunner = {
      run: () => '',
      tryRun(command, args) {
        events.push(`${command} ${args.join(' ')}`);
        if (args[0] === 'stop') {
          stopIssued = true;
          return { ok: true, stdout: '' };
        }
        return { ok: true, stdout: stopIssued ? '' : 'idle111' };
      },
    };
    runtime.drainContainers = (root) =>
      drainContainers(root, {
        platform: 'linux',
        home: os.homedir(),
        uid: 1000,
        runner: docker,
        sleep: async () => {},
      });

    const prepared = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    await validateUpdate(fixture.install, prepared.id, runtime);
    const cut = await cutoverUpdate(fixture.install, prepared.id, runtime);
    expect(cut.phase).toBe('cutover');
    // state.projectRoot is realpathed (macOS tmp lives under /var → /private/var), so derive the slug from it.
    const slugValue = getInstallSlug(cut.projectRoot);
    const ps = `docker ps --filter label=nanoclaw-install=${slugValue} --format ${DRAIN_LIST_FORMAT}`;
    expect(events.indexOf('service stop')).toBeLessThan(events.indexOf(ps));
    expect(events.filter((e) => e.startsWith('docker '))).toEqual([ps, 'docker stop -t 10 idle111', ps]);

    // Failure path: a container that survives the stop. Same ordering, and the
    // transaction must restart the old service with the state still validated.
    const stuck = createForkFixture();
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const stuckRun = fakeRuntime(stuck.install);
    stuckRun.runtime.drainContainers = (root) =>
      drainContainers(
        root,
        {
          platform: 'linux',
          home: os.homedir(),
          uid: 1000,
          runner: { run: () => '', tryRun: () => ({ ok: true, stdout: 'stuck222' }) },
          sleep: async () => {},
        },
        0,
      );
    const stuckPrepared = prepareUpdate({ projectRoot: stuck.install, upstreamRef: 'upstream/main' }, stuckRun.runtime);
    await validateUpdate(stuck.install, stuckPrepared.id, stuckRun.runtime);
    await expect(cutoverUpdate(stuck.install, stuckPrepared.id, stuckRun.runtime)).rejects.toThrow(
      'Timed out waiting for NanoClaw containers to stop: stuck222',
    );
    expect(stuckRun.events.slice(-2)).toEqual(['service stop', 'service start']);
    const after = loadState(stuck.install, stuckPrepared.id);
    expect(after.phase).toBe('validated');
    expect(after.snapshot).toBeUndefined();
    expect(exec(stuck.install, 'git', ['rev-parse', 'HEAD'])).toBe(stuckPrepared.originalHead);
  });

  it('a `docker stop` that stalls past its bound still lands cutover on the rollback path (review on #3873)', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const { runtime, events } = fakeRuntime(fixture.install);
    let clock = 5_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      // Real drain, default 60 s bound, under a runner whose `stop` "hangs"
      // until the subprocess timeout and whose `ps` keeps listing the container.
      runtime.drainContainers = (root) =>
        drainContainers(root, {
          platform: 'linux',
          home: os.homedir(),
          uid: 1000,
          runner: {
            run: () => '',
            tryRun(command, args, _cwd, options) {
              events.push(`${command} ${args.join(' ')}`);
              if (args[0] === 'stop') {
                clock += options?.timeoutMs ?? CUTOVER_STOP_CLI_TIMEOUT_MS;
                return { ok: false, stdout: 'ETIMEDOUT' };
              }
              return { ok: true, stdout: 'hung444' };
            },
          },
          sleep: async () => {
            clock += 1_000;
          },
        });
      const prepared = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
      await validateUpdate(fixture.install, prepared.id, runtime);
      await expect(cutoverUpdate(fixture.install, prepared.id, runtime)).rejects.toThrow(
        'Timed out waiting for NanoClaw containers to stop: hung444 (docker stop failed: ETIMEDOUT)',
      );
      // Service was stopped, the drain gave up inside the bound, the old service came back.
      expect(events.slice(-1)).toEqual(['service start']);
      expect(events.filter((e) => e === 'service stop')).toHaveLength(1);
      const after = loadState(fixture.install, prepared.id);
      expect(after.phase).toBe('validated');
      expect(after.snapshot).toBeUndefined();
      expect(after.lastError).toContain('ETIMEDOUT');
      expect(exec(fixture.install, 'git', ['rev-parse', 'HEAD'])).toBe(prepared.originalHead);
    } finally {
      now.mockRestore();
    }
  });

  it('re-runs cutover after a failed rollback left a populated snapshot (read-only files must not EACCES)', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    // Mutable state containing a read-only file, the way git pack files are:
    // the first snapshot copies it 0444, and a naive re-snapshot cannot
    // overwrite its own previous copy.
    write(fixture.install, 'data/objects/pack-test.idx', 'immutable\n');
    fs.chmodSync(path.join(fixture.install, 'data/objects/pack-test.idx'), 0o444);

    // First cutover: target build fails, and the rollback ALSO fails (health
    // verification refuses) — phase stays validated with the snapshot
    // directory populated. That is the state a second attempt starts from.
    let failTargetBuild = true;
    const { runtime } = fakeRuntime(fixture.install, { health: [false, true] });
    const baseRun = runtime.runner.run.bind(runtime.runner);
    runtime.runner.run = (command, args, cwd = fixture.install) => {
      if (command === 'pnpm' && args[1] === 'build' && failTargetBuild) {
        if (fs.readFileSync(path.join(fixture.install, 'src/value.ts'), 'utf8').includes('new')) {
          throw new Error('target build failed');
        }
      }
      return baseRun(command, args, cwd);
    };

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    await expect(cutoverUpdate(fixture.install, state.id, runtime)).rejects.toThrow();
    state = loadState(fixture.install, state.id);
    expect(state.phase).toBe('validated');
    expect(fs.existsSync(path.join(state.transactionRoot, 'snapshot', 'data/objects/pack-test.idx'))).toBe(true);

    // Second attempt with the cause fixed: must re-snapshot over the
    // read-only remains of the first and complete.
    failTargetBuild = false;
    state = await cutoverUpdate(fixture.install, state.id, runtime);
    expect(state.phase).toBe('cutover');
  });

  it('a snapshot that fails midway on a RETRY never lets the automatic rollback restore a partial copy', async () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');

    // Attempt 1: target build fails AND the rollback health-check refuses, so
    // the phase stays `validated` with a COMPLETE snapshot on disk — the
    // state a second attempt starts from.
    let failTargetBuild = true;
    const { runtime } = fakeRuntime(fixture.install, { health: [false, true] });
    const baseRun = runtime.runner.run.bind(runtime.runner);
    runtime.runner.run = (command, args, cwd = fixture.install) => {
      if (command === 'pnpm' && args[1] === 'build' && failTargetBuild) {
        if (fs.readFileSync(path.join(fixture.install, 'src/value.ts'), 'utf8').includes('new')) {
          throw new Error('target build failed');
        }
      }
      return baseRun(command, args, cwd);
    };

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    await expect(cutoverUpdate(fixture.install, state.id, runtime)).rejects.toThrow();
    state = loadState(fixture.install, state.id);
    expect(state.phase).toBe('validated');

    // Attempt 2's snapshot dies midway: an unreadable file that sorts BEFORE
    // v2.db makes copyEntry throw with the copy incomplete. The persisted
    // state still carries attempt 1's entry list, so the failure path will
    // run an automatic rollback — which must see a COMPLETE snapshot.
    failTargetBuild = false;
    write(fixture.install, 'data/aaa-unreadable', 'secret');
    fs.chmodSync(path.join(fixture.install, 'data/aaa-unreadable'), 0o000);
    try {
      await expect(cutoverUpdate(fixture.install, state.id, runtime)).rejects.toThrow(/EACCES|permission denied/i);

      // Live mutable state survived: the rollback restored the re-instated
      // complete prior snapshot, not the partial one.
      expect(fs.readFileSync(path.join(fixture.install, 'data/v2.db'), 'utf8')).toBe('old-schema');
      state = loadState(fixture.install, state.id);
      const snapshotDb = path.join(state.transactionRoot, 'snapshot', 'data/v2.db');
      expect(fs.existsSync(snapshotDb)).toBe(true);
      expect(fs.existsSync(path.join(state.transactionRoot, 'snapshot.prev'))).toBe(false);
    } finally {
      // A successful rollback legitimately removes the planted file (the
      // prior snapshot never contained it); re-chmod only if it survived.
      const planted = path.join(fixture.install, 'data/aaa-unreadable');
      if (fs.existsSync(planted)) fs.chmodSync(planted, 0o644);
    }
  });
});
