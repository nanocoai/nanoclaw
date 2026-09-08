import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const edge = vi.hoisted(() => ({
  confirm: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  nativeHome: '',
  exitCode: 0,
  postinstallExitCode: 0,
}));
vi.mock('@clack/prompts', () => ({
  confirm: edge.confirm,
  isCancel: (v: unknown) => typeof v === 'symbol',
  log: { info: vi.fn(), warn: vi.fn() },
  note: vi.fn(),
}));
vi.mock('child_process', () => ({ spawn: edge.spawn, spawnSync: edge.spawnSync }));
vi.mock('os', async (original) => ({
  default: { ...(await original<typeof import('os')>()).default, homedir: () => edge.nativeHome },
}));

import {
  findHostOpenCode,
  hostOpenCode,
  offerOpenCodeFailureAssist,
  runHostOpenCode,
  OPENCODE_HOST_INSTALL_VERSION,
} from './opencode-host.js';

let root: string;
function touch(file: string, content = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-host-test-'));
  edge.nativeHome = path.join(root, 'native-home');
  edge.exitCode = 0;
  edge.postinstallExitCode = 0;
  vi.stubEnv('PATH', path.join(root, 'bin'));
  vi.clearAllMocks();
  edge.confirm.mockResolvedValue(true);
  edge.spawnSync.mockReturnValue({ status: 0, stdout: OPENCODE_HOST_INSTALL_VERSION });
  edge.spawn.mockImplementation((binary: string, args: string[]) => {
    if (binary === 'npm' && edge.exitCode === 0) {
      touch(path.join(args[args.indexOf('--prefix') + 1], 'node_modules/.bin/opencode'));
    }
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', binary === process.execPath ? edge.postinstallExitCode : edge.exitCode));
    return child;
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('native host OpenCode lifecycle', () => {
  it('imports without running a CLI, authenticating, or changing configuration', async () => {
    vi.resetModules();
    await import('./opencode-host.js');
    expect(edge.spawn).not.toHaveBeenCalled();
    expect(edge.spawnSync).not.toHaveBeenCalled();
    expect(edge.confirm).not.toHaveBeenCalled();
  });

  it('preserves an existing native installation and configuration', async () => {
    const binary = path.join(root, 'bin/opencode');
    const config = path.join(edge.nativeHome, '.config/opencode/opencode.json');
    touch(binary, 'existing binary');
    touch(config, '{"model":"user/chosen-model"}');
    edge.spawnSync.mockReturnValue({ status: 0, stdout: '1.18.26' });
    expect(await hostOpenCode.prepare(root)).toBe('available');
    expect(findHostOpenCode(root)).toEqual({ binary, version: '1.18.26' });
    expect(fs.readFileSync(binary, 'utf8')).toBe('existing binary');
    expect(fs.readFileSync(config, 'utf8')).toBe('{"model":"user/chosen-model"}');
    expect(edge.spawn).not.toHaveBeenCalled();
    expect(edge.confirm).not.toHaveBeenCalled();
  });

  it('installs the exact CLI and runs only its native linker inside this checkout', async () => {
    expect(await hostOpenCode.prepare(root)).toBe('available');
    const [binary, args, options] = edge.spawn.mock.calls[0];
    expect(binary).toBe('npm');
    expect(args).toEqual([
      'install',
      '--prefix',
      path.join(root, 'data/host-harness/opencode'),
      '--no-save',
      '--package-lock=false',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `opencode-ai@${OPENCODE_HOST_INSTALL_VERSION}`,
    ]);
    expect(options).toEqual({ cwd: root, stdio: 'inherit' });
    expect(edge.spawn.mock.calls[1]).toEqual([
      process.execPath,
      [path.join(root, 'data/host-harness/opencode/node_modules/opencode-ai/postinstall.mjs')],
      { cwd: root, stdio: 'inherit' },
    ]);
    expect(edge.spawn).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(root, 'package.json'))).toBe(false);
  });

  it('treats declined installation, cancellation, and installer failure as unavailable', async () => {
    for (const value of [false, Symbol('cancel')]) {
      edge.confirm.mockResolvedValueOnce(value);
      expect(await hostOpenCode.prepare(root)).toBe('declined');
    }
    expect(edge.spawn).not.toHaveBeenCalled();
    edge.exitCode = 1;
    expect(await hostOpenCode.prepare(root)).toBe('unavailable');
    expect(edge.spawn).toHaveBeenCalledTimes(1);
  });

  it('rejects native-linker failures and a nonmatching installed CLI version', async () => {
    edge.postinstallExitCode = 1;
    expect(await hostOpenCode.prepare(root)).toBe('unavailable');
    edge.postinstallExitCode = 0;
    edge.spawnSync.mockReturnValueOnce({ status: 1, stdout: '' }).mockReturnValue({ status: 0, stdout: '1.18.24' });
    expect(await hostOpenCode.prepare(root)).toBe('unavailable');
  });

  it('uses the current checkout, native permissions, and only a context file reference in argv', async () => {
    touch(path.join(root, 'bin/opencode'));
    const context = path.join(root, 'context with spaces.md');
    touch(context, 'PRIVATE FAILURE DETAIL');
    expect(await hostOpenCode.launch(root, context)).toBe('exited');
    const [, args, options] = edge.spawn.mock.calls[0];
    expect(args).toEqual(['--prompt', `Read ${JSON.stringify(context)} and follow the maintenance request inside it.`]);
    expect(JSON.stringify(args)).not.toContain('PRIVATE FAILURE DETAIL');
    expect(args).not.toContain('--auto');
    expect(options).toEqual({ cwd: root, stdio: 'inherit' });
  });

  it('allows native configuration without consulting Docker or OneCLI', async () => {
    touch(path.join(root, 'bin/opencode'));
    expect(await hostOpenCode.configure(root)).toBe('exited');
    expect(edge.spawn.mock.calls[0][1]).toEqual([]);
    edge.exitCode = 1;
    expect(await hostOpenCode.launch(root)).toBe('failed');
  });
});

describe('existing setup failure-assist hook', () => {
  const context = { stepName: 'auth', msg: 'PRIVATE FAILURE DETAIL' };
  it('registers and invokes the installed provider hook with private temporary context', async () => {
    await import('../setup/providers/index.js');
    const { getSetupProvider } = await import('../setup/providers/registry.js');
    touch(path.join(root, 'bin/opencode'));
    let contextFile = '';
    edge.spawn.mockImplementation((_binary: string, args: string[]) => {
      contextFile = JSON.parse(args[1].slice('Read '.length).split(' and follow')[0]);
      expect(fs.readFileSync(contextFile, 'utf8')).toContain('PRIVATE FAILURE DETAIL');
      expect(fs.statSync(contextFile).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(contextFile)).mode & 0o777).toBe(0o700);
      expect(JSON.stringify(args)).not.toContain('PRIVATE FAILURE DETAIL');
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    expect(await getSetupProvider('opencode')!.offerFailureAssist!(context, root)).toBe('launched');
    expect(fs.existsSync(path.dirname(contextFile))).toBe(false);
  });
  it('preserves decline and unavailable outcomes for the shared dispatcher', async () => {
    edge.confirm.mockResolvedValueOnce(false);
    expect(await offerOpenCodeFailureAssist(context, root)).toBe('declined');
    expect(edge.spawn).not.toHaveBeenCalled();
    touch(path.join(root, 'bin/opencode'));
    edge.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('spawn failed')));
      return child;
    });
    expect(await offerOpenCodeFailureAssist(context, root)).toBe('unavailable');
  });
  it('does not launch a second assistant after OpenCode runs but exits unsuccessfully', async () => {
    touch(path.join(root, 'bin/opencode'));
    edge.exitCode = 1;
    expect(await offerOpenCodeFailureAssist(context, root)).toBe('launched');
  });
  it('routes standalone update work to the existing update skill', async () => {
    touch(path.join(root, 'bin/opencode'));
    edge.spawn.mockImplementation((_binary: string, args: string[]) => {
      const file = JSON.parse(args[1].slice('Read '.length).split(' and follow')[0]);
      expect(fs.readFileSync(file, 'utf8')).toContain('.claude/skills/update-nanoclaw/SKILL.md');
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    await runHostOpenCode(['--update'], root);
  });
});

it('reports standalone installation failure instead of a successful command exit', async () => {
  edge.exitCode = 1;
  await expect(runHostOpenCode(['--configure'], root)).rejects.toThrow('unavailable');
});
