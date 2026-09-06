import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { RunCommand } from './onecli-agents.js';
import type { RemovalAction } from './plan.js';
import { backupEnv, executePlan, type ExecDeps } from './remove.js';
import { pathIdentity } from './scan.js';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-remove-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function deps(overrides: Partial<ExecDeps> = {}): ExecDeps {
  return {
    runCommand: () => ({ status: 0, stdout: '' }),
    log: () => {},
    isRoot: false,
    ...overrides,
  };
}

describe('backupEnv', () => {
  it('backs up to .env.bak', () => {
    const envPath = path.join(tempDir, '.env');
    const backupRoot = path.join(tempDir, 'backup');
    fs.writeFileSync(envPath, 'KEY=secret');

    const backup = backupEnv(envPath, backupRoot);

    expect(backup).toBe(path.join(backupRoot, '.env.bak'));
    expect(fs.readFileSync(backup, 'utf-8')).toBe('KEY=secret');
  });

  it('falls back to a timestamped name when .env.bak exists', () => {
    const envPath = path.join(tempDir, '.env');
    const backupRoot = path.join(tempDir, 'backup');
    fs.writeFileSync(envPath, 'KEY=new');
    fs.mkdirSync(backupRoot);
    fs.writeFileSync(path.join(backupRoot, '.env.bak'), 'KEY=old');

    const backup = backupEnv(envPath, backupRoot);

    expect(path.basename(backup)).toMatch(/^\.env\.bak\.\d+-\d+-\d+$/);
    expect(fs.readFileSync(backup, 'utf-8')).toBe('KEY=new');
    // The earlier backup is never clobbered.
    expect(fs.readFileSync(path.join(backupRoot, '.env.bak'), 'utf-8')).toBe('KEY=old');
  });
});

describe('executePlan', () => {
  it('deletes paths recursively', () => {
    const dir = path.join(tempDir, 'data');
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nested', 'f.txt'), 'x');

    const { notes } = executePlan([{ kind: 'delete-path', item: { what: 'Data', where: dir, path: dir } }], deps());

    expect(fs.existsSync(dir)).toBe(false);
    expect(notes).toEqual([]);
  });

  it('blocks dependent deletion after a service-stop failure', () => {
    const dir = path.join(tempDir, 'logs');
    fs.mkdirSync(dir);
    const actions: RemovalAction[] = [
      {
        kind: 'unload-service',
        flavor: 'launchd',
        unitPath: path.join(tempDir, 'svc.plist'),
        unitName: 'com.nanoclaw-v2-test',
      },
      { kind: 'delete-path', item: { what: 'Logs', where: dir, path: dir } },
    ];
    const failing: RunCommand = () => {
      throw new Error('launchctl exploded');
    };

    const { notes, results } = executePlan(actions, deps({ runCommand: failing }));

    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain('unload-service');
    expect(notes[0]).toContain('launchctl exploded');
    expect(fs.existsSync(dir)).toBe(true);
    expect(results.at(-1)?.outcome).toBe('untouched');
  });

  it('leaves a system unit in place without root and notes the sudo command', () => {
    const unitPath = path.join(tempDir, 'nanoclaw-v2-test.service');
    fs.writeFileSync(unitPath, '[Unit]');
    const calls: string[] = [];
    const recorder: RunCommand = (cmd) => {
      calls.push(cmd);
      return { status: 0, stdout: '' };
    };

    const { notes } = executePlan(
      [
        {
          kind: 'unload-service',
          flavor: 'systemd-system',
          unitPath,
          unitName: 'nanoclaw-v2-test',
        },
      ],
      deps({ runCommand: recorder, isRoot: false }),
    );

    expect(fs.existsSync(unitPath)).toBe(true);
    expect(calls).toEqual([]);
    expect(notes.some((n) => n.includes('re-run with sudo'))).toBe(true);
  });

  it('notes a failed image removal with the retry command', () => {
    const { notes } = executePlan(
      [{ kind: 'rmi', runtime: 'docker', image: 'img:latest' }],
      deps({ runCommand: () => ({ status: 1, stdout: '' }) }),
    );
    expect(notes.some((n) => n.includes('docker rmi img:latest'))).toBe(true);
  });

  it('removes .env only after a successful backup', () => {
    const envPath = path.join(tempDir, '.env');
    fs.writeFileSync(envPath, 'KEY=secret');

    const { notes } = executePlan([{ kind: 'backup-env', envPath, backupRoot: path.join(tempDir, 'backup') }], deps());

    expect(fs.existsSync(envPath)).toBe(false);
    expect(fs.readFileSync(path.join(tempDir, 'backup', '.env.bak'), 'utf-8')).toBe('KEY=secret');
    expect(notes).toEqual([]);
  });

  it('keeps .env when the backup fails', () => {
    const envPath = path.join(tempDir, '.env');
    fs.writeFileSync(envPath, 'KEY=secret');
    fs.chmodSync(tempDir, 0o555); // backup destination unwritable

    try {
      const { notes } = executePlan(
        [{ kind: 'backup-env', envPath, backupRoot: path.join(tempDir, 'backup') }],
        deps(),
      );
      expect(fs.existsSync(envPath)).toBe(true);
      expect(notes.some((n) => n.includes('backup-env'))).toBe(true);
    } finally {
      fs.chmodSync(tempDir, 0o755);
    }
  });

  it('re-lists containers by label at removal time instead of using scan-time ids', () => {
    const calls: string[][] = [];
    const docker: RunCommand = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === 'ps') return { status: 0, stdout: 'fresh1\nfresh2\n' };
      return { status: 0, stdout: '' };
    };

    executePlan(
      [{ kind: 'rm-containers', runtime: 'docker', labelFilter: 'nanoclaw-install=abcd1234' }],
      deps({ runCommand: docker }),
    );

    expect(calls).toEqual([
      ['docker', 'ps', '-aq', '--filter', 'label=nanoclaw-install=abcd1234'],
      ['docker', 'rm', '-f', 'fresh1', 'fresh2'],
    ]);
  });

  it('notes a manual command when the container runtime is unavailable', () => {
    const { notes } = executePlan(
      [{ kind: 'rm-containers', runtime: 'docker', labelFilter: 'nanoclaw-install=x' }],
      deps({ runCommand: () => ({ status: null, stdout: '' }) }),
    );
    expect(notes.some((n) => n.includes('xargs -r docker rm -f'))).toBe(true);
  });

  it('blocks data and runtime deletion when container shutdown fails', () => {
    const dataPath = path.join(tempDir, 'data');
    const runtimePath = path.join(tempDir, 'node_modules');
    fs.mkdirSync(dataPath);
    fs.mkdirSync(runtimePath);

    const result = executePlan(
      [
        {
          kind: 'rm-containers',
          runtime: 'docker',
          labelFilter: 'nanoclaw-install=test',
        },
        {
          kind: 'delete-path',
          item: { what: 'Data', where: dataPath, path: dataPath },
        },
        {
          kind: 'delete-runtime-path',
          item: {
            what: 'Runtime',
            where: runtimePath,
            path: runtimePath,
          },
        },
      ],
      deps({ runCommand: () => ({ status: null, stdout: '' }) }),
    );

    expect(result.results.map((entry) => entry.outcome)).toEqual(['failed', 'untouched', 'untouched']);
    expect(fs.existsSync(dataPath)).toBe(true);
    expect(fs.existsSync(runtimePath)).toBe(true);
  });

  it('removes an already-stopped launchd service registration', () => {
    const unitPath = path.join(tempDir, 'service.plist');
    fs.writeFileSync(unitPath, 'service');

    const result = executePlan(
      [
        {
          kind: 'unload-service',
          flavor: 'launchd',
          unitPath,
          unitName: 'service',
        },
      ],
      deps({
        runCommand: () => ({
          status: 1,
          stdout: '',
          stderr: 'Could not find specified service',
        }),
      }),
    );

    expect(result.results[0]?.outcome).toBe('removed');
    expect(fs.existsSync(unitPath)).toBe(false);
  });

  it('notes a manual delete when onecli itself cannot be run', () => {
    const { notes } = executePlan(
      [
        {
          kind: 'delete-onecli-agent',
          agent: { uuid: 'u-123', identifier: 'ag-mine', name: 'Mine' },
        },
      ],
      deps({ runCommand: () => ({ status: null, stdout: '' }) }),
    );
    expect(notes.some((n) => n.includes('onecli agents delete --id u-123'))).toBe(true);
  });

  it('deletes OneCLI agents by vault uuid, never by identifier', () => {
    const calls: string[][] = [];
    const recorder: RunCommand = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '' };
    };

    executePlan(
      [
        {
          kind: 'delete-onecli-agent',
          agent: { uuid: 'u-123', identifier: 'ag-mine', name: 'Mine' },
        },
      ],
      deps({ runCommand: recorder }),
    );

    expect(calls).toEqual([['onecli', 'agents', 'delete', '--id', 'u-123']]);
  });

  it('leaves an exact filesystem artifact untouched when its identity changed', () => {
    const unitPath = path.join(tempDir, 'service.plist');
    fs.writeFileSync(unitPath, 'approved');
    const expectedIdentity = pathIdentity(unitPath);
    fs.writeFileSync(unitPath, 'replacement');

    const result = executePlan(
      [
        {
          kind: 'unload-service',
          flavor: 'launchd',
          unitPath,
          unitName: 'service',
          expectedIdentity,
          identityRequired: true,
        },
      ],
      deps(),
    );

    expect(result.results[0]?.outcome).toBe('untouched');
    expect(fs.readFileSync(unitPath, 'utf8')).toBe('replacement');
  });

  it('deletes an unchanged exact file but preserves a replacement', () => {
    const keptPath = path.join(tempDir, 'start-nanoclaw.sh');
    fs.writeFileSync(keptPath, '#!/bin/sh\n');
    const keptIdentity = pathIdentity(keptPath);
    const removed = executePlan(
      [
        {
          kind: 'delete-path',
          item: { what: 'Start script', where: keptPath, path: keptPath },
          expectedIdentity: keptIdentity,
          identityRequired: true,
        },
      ],
      deps(),
    );
    expect(removed.results[0]?.outcome).toBe('removed');
    expect(fs.existsSync(keptPath)).toBe(false);

    const replacementPath = path.join(tempDir, 'replacement.txt');
    fs.writeFileSync(replacementPath, 'approved');
    const replacementIdentity = pathIdentity(replacementPath);
    fs.writeFileSync(replacementPath, 'replacement');
    const preserved = executePlan(
      [
        {
          kind: 'delete-path',
          item: { what: 'Replacement', where: replacementPath, path: replacementPath },
          expectedIdentity: replacementIdentity,
          identityRequired: true,
        },
      ],
      deps(),
    );
    expect(preserved.results[0]?.outcome).toBe('untouched');
    expect(fs.readFileSync(replacementPath, 'utf8')).toBe('replacement');
  });

  it('does not unlink a service unit replaced while the stop command is running', () => {
    const unitPath = path.join(tempDir, 'service.plist');
    const dataPath = path.join(tempDir, 'data');
    fs.writeFileSync(unitPath, 'approved');
    fs.mkdirSync(dataPath);
    const expectedIdentity = pathIdentity(unitPath);
    const result = executePlan(
      [
        {
          kind: 'unload-service',
          flavor: 'launchd',
          unitPath,
          unitName: 'service',
          expectedIdentity,
          identityRequired: true,
        },
        { kind: 'delete-path', item: { what: 'Data', where: dataPath, path: dataPath } },
      ],
      deps({
        runCommand: () => {
          fs.writeFileSync(unitPath, 'replacement');
          return { status: 0, stdout: '' };
        },
      }),
    );

    expect(result.results[0]).toEqual(
      expect.objectContaining({
        outcome: 'untouched',
        error: expect.objectContaining({ code: 'identity_changed' }),
      }),
    );
    expect(result.results[1]).toEqual(
      expect.objectContaining({
        outcome: 'untouched',
        error: expect.objectContaining({ code: 'service_prerequisite_failed' }),
      }),
    );
    expect(fs.readFileSync(unitPath, 'utf8')).toBe('replacement');
    expect(fs.existsSync(dataPath)).toBe(true);
  });

  it('rechecks a checkout-owned directory root immediately before recursive deletion', () => {
    const dir = path.join(tempDir, 'data');
    fs.mkdirSync(dir);
    const expectedRootIdentity = pathIdentity(dir);
    fs.renameSync(dir, `${dir}.approved`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'replacement.txt'), 'keep');

    const result = executePlan(
      [
        {
          kind: 'delete-path',
          item: { what: 'Data', where: dir, path: dir },
          expectedRootIdentity,
        },
      ],
      deps(),
    );

    expect(result.results[0]?.outcome).toBe('untouched');
    expect(fs.readFileSync(path.join(dir, 'replacement.txt'), 'utf8')).toBe('keep');
  });

  it('does not signal a non-host pidfile target that mentions this checkout', () => {
    const pidFile = path.join(tempDir, 'nanoclaw.pid');
    const processPattern = `${tempDir}/dist/index.js`;
    fs.writeFileSync(pidFile, '321');
    const killed: number[] = [];
    const result = executePlan(
      [
        {
          kind: 'kill-pid',
          pidFile,
          processPattern,
          expectedIdentity: pathIdentity(pidFile),
          identityRequired: true,
        },
      ],
      deps({
        runCommand: () => ({ status: 0, stdout: `/usr/bin/vim ${processPattern}\n` }),
        killProcess: (pid) => {
          killed.push(pid);
        },
      }),
    );

    expect(result.results[0]?.outcome).toBe('untouched');
    expect(killed).toEqual([]);
    expect(fs.existsSync(pidFile)).toBe(true);
  });

  it('waits for an owned pidfile process to stop before satisfying the prerequisite', () => {
    const pidFile = path.join(tempDir, 'nanoclaw.pid');
    const processPattern = `${tempDir}/dist/index.js`;
    fs.writeFileSync(pidFile, '321');
    let checks = 0;
    const result = executePlan(
      [
        {
          kind: 'kill-pid',
          pidFile,
          processPattern,
          expectedIdentity: pathIdentity(pidFile),
          identityRequired: true,
        },
      ],
      deps({
        runCommand: () => ({ status: ++checks < 4 ? 0 : 1, stdout: `/usr/bin/node ${processPattern}\n` }),
        killProcess: () => {},
        sleep: () => {},
      }),
    );

    expect(result.results[0]?.outcome).toBe('removed');
    expect(checks).toBeGreaterThanOrEqual(4);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('re-lists only the NanoClaw node argv shape, not editors or grep', () => {
    const processPattern = `${tempDir}/dist/index.js`;
    const killed: number[] = [];
    let listings = 0;
    const result = executePlan(
      [{ kind: 'pkill-host', pattern: processPattern }],
      deps({
        runCommand: () => ({
          status: 0,
          stdout:
            listings++ === 0
              ? `321 /usr/bin/node ${processPattern}\n322 /usr/bin/vim ${processPattern}\n323 grep ${processPattern}\n`
              : `322 /usr/bin/vim ${processPattern}\n323 grep ${processPattern}\n`,
        }),
        killProcess: (pid) => {
          killed.push(pid);
        },
        sleep: () => {},
      }),
    );

    expect(result.results[0]?.outcome).toBe('removed');
    expect(killed).toEqual([321]);
  });

  it('rechecks the exact image identity immediately before removal', () => {
    const calls: string[][] = [];
    const result = executePlan(
      [
        {
          kind: 'rmi',
          runtime: 'docker',
          image: 'img:latest',
          expectedIdentity: '{"Id":"approved"}',
          identityRequired: true,
        },
      ],
      deps({
        runCommand: (cmd, args) => {
          calls.push([cmd, ...args]);
          return { status: 0, stdout: '{"Id":"replacement"}' };
        },
      }),
    );

    expect(result.results[0]?.outcome).toBe('untouched');
    expect(calls).toEqual([['docker', 'image', 'inspect', 'img:latest']]);
  });

  it('does not delete OneCLI agents after service failure', () => {
    const unitPath = path.join(tempDir, 'service.plist');
    const dataPath = path.join(tempDir, 'data');
    fs.writeFileSync(unitPath, 'service');
    fs.mkdirSync(dataPath);
    const calls: string[][] = [];
    const runCommand: RunCommand = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'launchctl') return { status: 1, stdout: '' };
      return { status: 0, stdout: '' };
    };
    const result = executePlan(
      [
        { kind: 'unload-service', flavor: 'launchd', unitPath, unitName: 'service' },
        { kind: 'delete-onecli-agent', agent: { uuid: 'u-1', identifier: 'ag-1', name: 'Agent' } },
        { kind: 'delete-path', item: { what: 'Data', where: dataPath, path: dataPath } },
      ],
      deps({ runCommand }),
    );

    expect(result.results.map((entry) => entry.outcome)).toEqual(['failed', 'untouched', 'untouched']);
    expect(calls.some((call) => call.join(' ') === 'onecli agents delete --id u-1')).toBe(false);
    expect(fs.existsSync(dataPath)).toBe(true);
  });
});
