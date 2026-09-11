import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  acknowledgeRequirement,
  cleanupUpdate,
  cutoverUpdate,
  finishUpdate,
  loadState,
  prepareUpdate,
  pruneTransactions,
  rollbackUpdate,
  validateUpdate,
  type UpdateRuntime,
} from './transaction.js';
import { stopService } from './service.js';
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

function createForkFixture(options: { breaking?: boolean; externalPinMove?: boolean } = {}): Fixture {
  const seed = temp('nanoclaw-update-seed-');
  exec(seed, 'git', ['init', '-b', 'main']);
  write(seed, 'package.json', '{"name":"nanoclaw-test","version":"2.1.54"}\n');
  write(seed, '.gitignore', 'data/\n.env\nstart-nanoclaw.sh\nnanoclaw.pid\n');
  write(seed, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
  write(seed, 'src/channels/index.ts', "import './cli.js';\n");
  write(seed, 'src/providers/index.ts', '');
  write(seed, 'container/agent-runner/src/providers/index.ts', "import './claude.js';\n");
  write(seed, 'versions.json', '{"onecli-gateway":"1.0.0","onecli-cli":"1.0.0"}\n');
  write(seed, 'CHANGELOG.md', '# Changelog\n');
  write(seed, 'src/value.ts', 'export const value = "old";\n');
  commit(seed, 'base');

  const official = temp('nanoclaw-update-official-');
  fs.rmSync(official, { recursive: true });
  exec(path.dirname(official), 'git', ['clone', '--bare', seed, official]);
  const fork = temp('nanoclaw-update-fork-');
  fs.rmSync(fork, { recursive: true });
  exec(path.dirname(fork), 'git', ['clone', '--bare', official, fork]);

  write(seed, 'src/value.ts', 'export const value = "new";\n');
  if (options.breaking) {
    fs.appendFileSync(
      path.join(seed, 'CHANGELOG.md'),
      '- [BREAKING] Test schema migration. Follow [the guide](docs/test-migration.md).\n',
    );
    write(seed, 'docs/test-migration.md', '# Test migration\n');
  }
  if (options.externalPinMove) {
    write(seed, 'versions.json', '{"onecli-gateway":"2.0.0","onecli-cli":"1.0.0"}\n');
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

afterEach(() => {
  if (previousUpdateDir === undefined) delete process.env.NANOCLAW_UPDATE_DIR;
  else process.env.NANOCLAW_UPDATE_DIR = previousUpdateDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('update-nanoclaw transaction end to end', () => {
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
    state = await rollbackUpdate(fixture.install, state.id, runtime);
    expect(state.phase).toBe('rolled-back');
    expect(exec(fixture.install, 'git', ['rev-parse', 'HEAD'])).toBe(fixture.originalHead);
    expect(fs.readFileSync(path.join(fixture.install, 'data/v2.db'), 'utf8')).toBe('old-schema');
    expect(fs.readFileSync(path.join(fixture.install, '.env'), 'utf8')).toBe('EXAMPLE=old\n');
    expect(fs.readFileSync(path.join(fixture.install, 'start-nanoclaw.sh'), 'utf8')).toBe(
      '#!/bin/bash\nnode dist/index.js\n',
    );
    expect(fs.readFileSync(path.join(fixture.install, 'nanoclaw.pid'), 'utf8')).toBe('1234\n');
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

  it('gates external version-pin moves and retains an exact rollback target', async () => {
    const fixture = createForkFixture({ externalPinMove: true });
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    process.env.NANOCLAW_UPDATE_DIR = temp('nanoclaw-update-state-');
    const { runtime } = fakeRuntime(fixture.install);

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);

    expect(state.requirements).toMatchObject([
      {
        type: 'external-component',
        description: 'onecli-gateway: 1.0.0 → 2.0.0',
        status: 'pending',
        rollback: 'Restore onecli-gateway to 1.0.0',
      },
    ]);
    await expect(finishUpdate(fixture.install, state.id, runtime)).rejects.toThrow('Unresolved migrations');

    state = acknowledgeRequirement(fixture.install, state.id, state.requirements[0].id, 'succeeded', undefined);
    state = await finishUpdate(fixture.install, state.id, runtime);
    expect(state.phase).toBe('complete');
    expect(state.requirements[0].rollback).toBe('Restore onecli-gateway to 1.0.0');
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
