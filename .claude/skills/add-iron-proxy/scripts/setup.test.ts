import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as yaml } from 'yaml';

import { InstallCommandFailure } from './install-command.js';

/** A fresh arm64 Linux engine with no cached images; the kernel's QEMU registration varies per test. */
const engine = { emulation: false, calls: [] as string[][] };

// The kernel's QEMU registration, never the test machine's own.
const X86_64_HANDLER =
  'enabled\ninterpreter /usr/bin/qemu-x86_64\nflags: POCF\noffset 0\nmagic 7f454c4602010100000000000000000002003e00\nmask fffffffffffefe00fffffffffffffffffeffffff\n';
const readFileSync = fs.readFileSync;
vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
  if (typeof file === 'string' && file.startsWith('/proc/sys/fs/binfmt_misc/')) {
    if (file.endsWith('/status')) return 'enabled\n';
    if (!engine.emulation) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    return X86_64_HANDLER;
  }
  return (readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
}) as typeof fs.readFileSync);
const readdirSync = fs.readdirSync;
vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, ...rest: unknown[]) => {
  if (dir === '/proc/sys/fs/binfmt_misc')
    return engine.emulation ? ['qemu-x86_64', 'register', 'status'] : ['register', 'status'];
  return (readdirSync as (...args: unknown[]) => unknown)(dir, ...rest);
}) as typeof fs.readdirSync);
const composeStarted = new Error('compose up reached');

vi.mock('./install-command.js', async (original) => {
  const actual = await original<typeof import('./install-command.js')>();
  return {
    ...actual,
    installCommand: vi.fn(async (command: string, args: string[], options: { label: string; absentHint?: string }) => {
      engine.calls.push([command, ...args]);
      if (command === 'git' || command === 'python3') return '';
      if (command !== 'docker') throw new Error(`unexpected command: ${command}`);
      if (args[0] === 'info') return `aarch64 ${os.release()} ${os.hostname()}\n`;
      if (args[0] === 'build') return '';
      if (args[0] === 'image' && args[1] === 'inspect') {
        if (!engine.calls.some((call) => call[1] === 'build')) {
          throw new actual.InstallCommandFailure(`${options.label}: ${options.absentHint ?? 'failed (exit 1)'}`);
        }
        return `sha256:${'b'.repeat(64)}`;
      }
      if (args[0] === 'volume') return '';
      if (args[0] === 'compose') throw composeStarted;
      throw new Error(`unexpected command: docker ${args.join(' ')}`);
    }),
  };
});

const { run } = await import('./setup.js');
const { installCommand } = await import('./install-command.js');
const installCommandMock = vi.mocked(installCommand);
const { controlPaths } = await import('./control.js');
const { hasAmd64Emulation } = await import('./control-preflight.js');

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const roots: string[] = [];

beforeEach(() => {
  engine.calls.length = 0;
  engine.emulation = false;
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-setup-test-'));
  roots.push(root);
  return root;
}

const dockerVerbs = () => engine.calls.filter((call) => call[0] === 'docker').map((call) => call[1]);

describe('Iron Proxy setup on an arm64 Linux engine', () => {
  it('stops before building or fetching anything when the engine cannot run amd64 images', async () => {
    const root = project();
    const failure = await run(['--with-control'], root).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(InstallCommandFailure);
    const message = (failure as Error).message;
    expect(message).toContain('Iron Control cannot run on this aarch64 Docker engine');
    expect(message).toMatch(
      /docker run --privileged --rm docker\.io\/tonistiigi\/binfmt:\S+@sha256:[0-9a-f]{64} --install amd64/,
    );
    expect(message).toContain('OneCLI gateway');
    expect(dockerVerbs()).toEqual(['info']);
    expect(engine.calls.some((call) => call[0] === 'git' || call[0] === 'python3')).toBe(false);
    expect(fs.existsSync(controlPaths(root).compose)).toBe(false);
  });

  it('leaves an engine on another kernel alone, since it cannot inspect it', async () => {
    // Docker Desktop, a VM or a remote daemon: same kernel release here, but another host.
    installCommandMock.mockImplementationOnce(async (command: string, args: string[]) => {
      engine.calls.push([command, ...args]);
      return `aarch64 ${os.release()} other-host\n`;
    });
    const root = project();
    await expect(run(['--with-control'], root)).rejects.toBe(composeStarted);
    expect(dockerVerbs()[0]).toBe('info');
    expect(yaml(fs.readFileSync(controlPaths(root).compose, 'utf8')).services.web.platform).toBe('linux/amd64');
  });

  it('keeps the pinned amd64 console image where the kernel has a QEMU handler', async () => {
    engine.emulation = true;
    const root = project();
    await expect(run(['--with-control'], root)).rejects.toBe(composeStarted);
    expect(dockerVerbs().filter((verb) => verb === 'build')).toHaveLength(1);
    const web = yaml(fs.readFileSync(controlPaths(root).compose, 'utf8')).services.web;
    expect(web.image).toMatch(/^docker.io\/ironsh\/iron-control:.*@sha256:[a-f0-9]{64}$/);
    expect(web.platform).toBe('linux/amd64');
  });
});

describe('amd64 emulation probe', () => {
  const x86 =
    'enabled\ninterpreter /run/qemu-x86_64\nflags: POCF\noffset 0\nmagic 7f454c4602010100000000000000000002003e00\nmask ffffffffff\n';
  const arm = x86.replace('3e00', 'b700');
  const kernel = (status: string, handlers: Record<string, string>) => ({
    list: () => ['register', 'status', ...Object.keys(handlers)],
    read: (file: string) => {
      if (file === 'status') return status;
      if (file in handlers) return handlers[file];
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    },
  });
  const probe = (status: string, handlers: Record<string, string>) => {
    const k = kernel(status, handlers);
    return hasAmd64Emulation(k.list, k.read);
  };

  it('accepts an enabled x86-64 handler with the F flag under any name', () => {
    expect(probe('enabled', { 'qemu-x86_64': x86 })).toBe(true);
    expect(probe('enabled', { 'x86_64-linux': x86, 'qemu-aarch64': arm })).toBe(true);
  });

  it('rejects a missing, disabled, non-fixed or other-architecture handler and no binfmt at all', () => {
    expect(probe('enabled', {})).toBe(false);
    expect(probe('enabled', { 'qemu-aarch64': arm })).toBe(false);
    expect(probe('disabled', { 'qemu-x86_64': x86 })).toBe(false);
    expect(probe('enabled', { 'qemu-x86_64': x86.replace('enabled', 'disabled') })).toBe(false);
    expect(probe('enabled', { 'qemu-x86_64': x86.replace('POCF', 'POC') })).toBe(false);
    expect(probe('enabled', { 'qemu-x86_64': x86.replace('offset 0', 'offset 18') })).toBe(false);
    expect(probe('enabled', { 'qemu-i386-like': x86.replace('7f454c4602', '7f454c4601') })).toBe(false);
  });

  it('answers unknown, never absent, when binfmt_misc is not readable here', () => {
    const missing = () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    expect(hasAmd64Emulation(missing, missing)).toBeUndefined();
    // Listing or a handler read failing after a readable status is unknown too.
    expect(hasAmd64Emulation(missing, (file) => (file === 'status' ? 'enabled' : missing()))).toBeUndefined();
    expect(
      hasAmd64Emulation(
        () => ['gone', 'status'],
        (file) => (file === 'status' ? 'enabled' : missing()),
      ),
    ).toBeUndefined();
  });
});
