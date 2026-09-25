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
  warn: vi.fn(),
}));
vi.mock('@clack/prompts', () => ({
  confirm: edge.confirm,
  isCancel: (v: unknown) => typeof v === 'symbol',
  log: { info: vi.fn(), warn: edge.warn },
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
import { ASSIST_GUARDRAILS } from '../setup/lib/assist-guardrails.js';

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
  edge.spawnSync.mockImplementation((_binary: string, args: string[]) => ({
    status: 0,
    stdout: args[0] === '--help' ? '      --prompt        prompt to use [string]' : OPENCODE_HOST_INSTALL_VERSION,
  }));
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
    edge.spawnSync.mockImplementation((_binary: string, args: string[]) => ({
      status: 0,
      stdout: args[0] === '--help' ? '      --prompt        prompt to use [string]' : '1.18.26',
    }));
    expect(await hostOpenCode.prepare(root)).toBe('available');
    expect(findHostOpenCode(root)).toEqual({ binary, version: '1.18.26' });
    expect(fs.readFileSync(binary, 'utf8')).toBe('existing binary');
    expect(fs.readFileSync(config, 'utf8')).toBe('{"model":"user/chosen-model"}');
    expect(edge.spawn).not.toHaveBeenCalled();
    expect(edge.confirm).not.toHaveBeenCalled();
  });

  it('rejects an old CLI and one without the maintenance prompt option', () => {
    touch(path.join(root, 'bin/opencode'));
    edge.spawnSync.mockReturnValue({ status: 0, stdout: '1.18.24' });
    expect(findHostOpenCode(root)).toBeUndefined();
    edge.spawnSync.mockImplementation((_binary: string, args: string[]) => ({
      status: 0,
      stdout: args[0] === '--help' ? 'Usage: opencode [project]' : '1.18.25',
    }));
    expect(findHostOpenCode(root)).toBeUndefined();
  });

  it('accepts successful stderr-only help after installation and for later launches', async () => {
    edge.spawnSync.mockImplementation((_binary: string, args: string[]) => ({
      status: 0,
      stdout: args[0] === '--help' ? '' : OPENCODE_HOST_INSTALL_VERSION,
      stderr: args[0] === '--help' ? '      --prompt        prompt to use [string]' : '',
    }));
    expect(await hostOpenCode.prepare(root)).toBe('available');
    const binary = path.join(root, 'data/host-harness/opencode/node_modules/.bin/opencode');
    expect(findHostOpenCode(root)).toEqual({ binary, version: OPENCODE_HOST_INSTALL_VERSION });
    expect(await hostOpenCode.launch(root)).toBe('exited');
    expect(edge.spawn).toHaveBeenLastCalledWith(binary, [], {
      cwd: root,
      stdio: 'inherit',
      env: expect.objectContaining({ OPENCODE_PERMISSION: expect.any(String) }),
    });
  });

  it('rejects failed help commands even when stderr names the maintenance option', () => {
    touch(path.join(root, 'bin/opencode'));
    edge.spawnSync.mockImplementation((_binary: string, args: string[]) => ({
      status: args[0] === '--help' ? 1 : 0,
      stdout: args[0] === '--help' ? '' : OPENCODE_HOST_INSTALL_VERSION,
      stderr: args[0] === '--help' ? '      --prompt        prompt to use [string]' : '',
    }));
    expect(findHostOpenCode(root)).toBeUndefined();
  });

  it('prefers a newer compatible native installation over the managed copy', () => {
    const native = path.join(root, 'bin/opencode');
    const managed = path.join(root, 'data/host-harness/opencode/node_modules/.bin/opencode');
    touch(native);
    touch(managed);
    edge.spawnSync.mockImplementation((binary: string, args: string[]) => ({
      status: 0,
      stdout:
        args[0] === '--help'
          ? '      --prompt        prompt to use [string]'
          : binary === native
            ? '1.19.0'
            : '1.18.25',
    }));
    expect(findHostOpenCode(root)).toEqual({ binary: native, version: '1.19.0' });
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

  it('distinguishes declined installation, cancellation, and installer failure', async () => {
    edge.confirm.mockResolvedValueOnce(false);
    expect(await hostOpenCode.prepare(root)).toBe('declined');
    edge.confirm.mockResolvedValueOnce(Symbol('cancel'));
    expect(await hostOpenCode.prepare(root)).toBe('cancelled');
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

  it('uses the current checkout, a restrictive permission override, and only a context file reference in argv', async () => {
    touch(path.join(root, 'bin/opencode'));
    const context = path.join(root, 'context with spaces.md');
    touch(context, 'PRIVATE FAILURE DETAIL');
    expect(await hostOpenCode.launch(root, context)).toBe('exited');
    const [, args, options] = edge.spawn.mock.calls[0];
    expect(args).toEqual(['--prompt', `Read ${JSON.stringify(context)} and follow the maintenance request inside it.`]);
    expect(JSON.stringify(args)).not.toContain('PRIVATE FAILURE DETAIL');
    expect(args).not.toContain('--auto');
    expect(options.cwd).toBe(root);
    expect(options.stdio).toBe('inherit');
    expect(options.env.PATH).toBe(process.env.PATH);
    // OPENCODE_PERMISSION merges after the global and project config, so it
    // wins over an operator's own allow-all settings.
    const permission = JSON.parse(options.env.OPENCODE_PERMISSION);
    expect(permission.edit).toBe('ask');
    const bash = Object.entries(permission.bash as Record<string, string>);
    // Last matching rule wins: the catch-all must come first.
    expect(bash[0]).toEqual(['*', 'ask']);
    // No allow rules: OpenCode matches a grouped redirection such as
    // `(ls) > file` as plain `ls`, so any bash allow can write files.
    expect(Object.values(permission.bash)).not.toContain('allow');
    // Subagents carry their own (possibly operator-loosened) permissions.
    expect(permission.task).toBe('deny');
    for (const denied of ['docker rm *', 'docker * rm *', 'docker * down *', 'launchctl * unload *']) {
      expect(permission.bash[denied]).toBe('deny');
    }
    // Agent-level permission blocks in the operator's config are merged after
    // the top-level rules, so the session also runs as a dedicated default
    // agent whose name no operator config can target.
    const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
    expect(config.default_agent).toBe('nanoclaw-maintenance');
    expect(config.agent['nanoclaw-maintenance']).toMatchObject({ mode: 'primary', permission });
  });

  it('keeps an operator-supplied inline config while adding the maintenance agent', async () => {
    touch(path.join(root, 'bin/opencode'));
    vi.stubEnv(
      'OPENCODE_CONFIG_CONTENT',
      JSON.stringify({ model: 'user/model', agent: { mine: { mode: 'primary' } } }),
    );
    await hostOpenCode.launch(root);
    const config = JSON.parse(edge.spawn.mock.calls[0][2].env.OPENCODE_CONFIG_CONTENT);
    expect(config.model).toBe('user/model');
    expect(config.agent.mine).toEqual({ mode: 'primary' });
    expect(config.default_agent).toBe('nanoclaw-maintenance');
  });

  it('leaves a non-JSON inline config intact and keeps only the top-level override', async () => {
    touch(path.join(root, 'bin/opencode'));
    const jsonc = '{ // operator provider\n "model": "user/model", }';
    vi.stubEnv('OPENCODE_CONFIG_CONTENT', jsonc);
    await hostOpenCode.launch(root);
    const env = edge.spawn.mock.calls[0][2].env;
    expect(env.OPENCODE_CONFIG_CONTENT).toBe(jsonc);
    expect(JSON.parse(env.OPENCODE_PERMISSION).edit).toBe('ask');
  });

  it('matches bash commands against the permission override as OpenCode 1.18 does', async () => {
    touch(path.join(root, 'bin/opencode'));
    await hostOpenCode.launch(root);
    const rules = Object.entries(
      JSON.parse(edge.spawn.mock.calls[0][2].env.OPENCODE_PERMISSION).bash as Record<string, string>,
    );
    // Mirrors OpenCode's Wildcard.match (a trailing " *" also matches no arguments)
    // and its findLast evaluation.
    const action = (command: string) =>
      rules.findLast(([pattern]) => {
        let source = pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.');
        if (source.endsWith(' .*')) source = source.slice(0, -3) + '( .*)?';
        return new RegExp(`^${source}$`, 's').test(command);
      })?.[1];
    expect(action('docker ps')).toBe('ask');
    expect(action('tail -n 50 logs/setup.log')).toBe('ask');
    expect(action('docker inspect nanoclaw-iron-proxy')).toBe('ask');
    expect(action('curl -x http://proxy:8080 https://example.com')).toBe('ask');
    expect(action('docker rm -f nanoclaw-iron-proxy')).toBe('deny');
    expect(action('docker stop nanoclaw-iron-control')).toBe('deny');
    expect(action('launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist')).toBe('deny');
    // Variants with options between the tool and the verb.
    expect(action('docker compose -f compose.yml down')).toBe('deny');
    expect(action('docker container rm nanoclaw-iron-proxy')).toBe('deny');
    expect(action('systemctl --user --no-block stop nanoclaw.service')).toBe('deny');
    expect(action('launchctl bootout gui/501/com.nanoclaw')).toBe('deny');
    // OpenCode extracts `ls` from `(ls) > src/index.ts`; it must still ask.
    expect(action('ls')).toBe('ask');
    expect(action('ncl groups restart --id g1 --rebuild --message "get ready"')).toBe('ask');
    expect(action('cat .env')).toBe('ask');
  });

  it('keeps native configuration free of the maintenance override', async () => {
    touch(path.join(root, 'bin/opencode'));
    await hostOpenCode.configure(root);
    expect(edge.spawn.mock.calls[0][2]).toEqual({ cwd: root, stdio: 'inherit' });
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
  const context = { stepName: 'auth', msg: 'PRIVATE FAILURE DETAIL', hint: 'Authentication callback failed' };
  it('registers and invokes the installed provider hook with private temporary context', async () => {
    await import('../setup/providers/index.js');
    const { getSetupProvider } = await import('../setup/providers/registry.js');
    touch(path.join(root, 'bin/opencode'));
    let contextFile = '';
    edge.spawn.mockImplementation((_binary: string, args: string[]) => {
      contextFile = JSON.parse(args[1].slice('Read '.length).split(' and follow')[0]);
      expect(fs.readFileSync(contextFile, 'utf8')).toContain('PRIVATE FAILURE DETAIL');
      expect(fs.readFileSync(contextFile, 'utf8')).toContain('Authentication callback failed');
      for (const line of ASSIST_GUARDRAILS) expect(fs.readFileSync(contextFile, 'utf8')).toContain(line);
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
  it('allows guarded fallback when help was accepted but installing OpenCode was declined', async () => {
    edge.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await offerOpenCodeFailureAssist(context, root)).toBe('unavailable');
    expect(edge.spawn).not.toHaveBeenCalled();
  });
  it('preserves cancellation at the installation prompt', async () => {
    edge.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(Symbol('cancel'));
    expect(await offerOpenCodeFailureAssist(context, root)).toBe('declined');
    expect(edge.spawn).not.toHaveBeenCalled();
  });
  it('does not launch a second assistant after OpenCode runs but exits unsuccessfully', async () => {
    touch(path.join(root, 'bin/opencode'));
    edge.exitCode = 1;
    expect(await offerOpenCodeFailureAssist(context, root)).toBe('launched');
    expect(edge.warn).toHaveBeenCalledWith(expect.stringContaining('exited unsuccessfully'));
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
  it('asks before every update command but leaves the cutover to the update skill', async () => {
    touch(path.join(root, 'bin/opencode'));
    let permission: { edit: string; bash: Record<string, string> } | undefined;
    let context = '';
    edge.spawn.mockImplementation((_binary: string, args: string[], options: { env: Record<string, string> }) => {
      context = fs.readFileSync(JSON.parse(args[1].slice('Read '.length).split(' and follow')[0]), 'utf8');
      permission = JSON.parse(options.env.OPENCODE_PERMISSION);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    await runHostOpenCode(['--update'], root);
    expect(permission!.edit).toBe('ask');
    expect(permission!.bash['*']).toBe('ask');
    // The update skill stops the service and drains containers itself.
    expect(Object.values(permission!.bash)).not.toContain('deny');
    expect(context).not.toContain(ASSIST_GUARDRAILS[1]);

    await runHostOpenCode(['--debug'], root);
    expect(permission!.bash['docker rm *']).toBe('deny');
    for (const line of ASSIST_GUARDRAILS) expect(context).toContain(line);
  });
});

it('reports standalone installation failure instead of a successful command exit', async () => {
  edge.exitCode = 1;
  await expect(runHostOpenCode(['--configure'], root)).rejects.toThrow('unavailable');
});
