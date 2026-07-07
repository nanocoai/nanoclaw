import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { RunCommand } from './onecli-agents.js';
import type { RemovalAction } from './plan.js';
import { backupEnv, executePlan, type ExecDeps } from './remove.js';

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
    fs.writeFileSync(envPath, 'KEY=secret');

    const backup = backupEnv(envPath);

    expect(backup).toBe(path.join(tempDir, '.env.bak'));
    expect(fs.readFileSync(backup, 'utf-8')).toBe('KEY=secret');
  });

  it('falls back to a timestamped name when .env.bak exists', () => {
    const envPath = path.join(tempDir, '.env');
    fs.writeFileSync(envPath, 'KEY=new');
    fs.writeFileSync(path.join(tempDir, '.env.bak'), 'KEY=old');

    const backup = backupEnv(envPath);

    expect(path.basename(backup)).toMatch(/^\.env\.bak\.\d{8}-\d{6}$/);
    expect(fs.readFileSync(backup, 'utf-8')).toBe('KEY=new');
    // The earlier backup is never clobbered.
    expect(fs.readFileSync(path.join(tempDir, '.env.bak'), 'utf-8')).toBe('KEY=old');
  });
});

describe('executePlan', () => {
  it('deletes paths recursively', () => {
    const dir = path.join(tempDir, 'data');
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nested', 'f.txt'), 'x');

    const { notes } = executePlan(
      [{ kind: 'delete-path', item: { what: 'Data', where: dir, path: dir } }],
      deps(),
    );

    expect(fs.existsSync(dir)).toBe(false);
    expect(notes).toEqual([]);
  });

  it('continues past a failing action and records a note', () => {
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

    const { notes } = executePlan(actions, deps({ runCommand: failing }));

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('unload-service');
    expect(notes[0]).toContain('launchctl exploded');
    // Later actions still ran.
    expect(fs.existsSync(dir)).toBe(false);
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

    const { notes } = executePlan([{ kind: 'backup-env', envPath }], deps());

    expect(fs.existsSync(envPath)).toBe(false);
    expect(fs.readFileSync(path.join(tempDir, '.env.bak'), 'utf-8')).toBe('KEY=secret');
    expect(notes).toEqual([]);
  });

  it('keeps .env when the backup fails', () => {
    const envPath = path.join(tempDir, '.env');
    fs.writeFileSync(envPath, 'KEY=secret');
    fs.chmodSync(tempDir, 0o555); // backup destination unwritable

    try {
      const { notes } = executePlan([{ kind: 'backup-env', envPath }], deps());
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
});
