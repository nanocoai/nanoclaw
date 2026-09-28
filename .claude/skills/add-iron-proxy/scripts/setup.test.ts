import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as yaml } from 'yaml';

import { InstallCommandFailure } from './install-command.js';

/** A fresh arm64 Linux engine with no cached images; Buildx and binfmt vary per test. */
const engine = { emulation: false, buildx: true, calls: [] as string[][] };

// The kernel's QEMU registration, never the test machine's own.
const readFileSync = fs.readFileSync;
vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
  if (typeof file === 'string' && file.startsWith('/proc/sys/fs/binfmt_misc/')) {
    if (!engine.emulation) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    return 'enabled\ninterpreter /usr/bin/qemu-x86_64\nflags: POCF\n';
  }
  return (readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
}) as typeof fs.readFileSync);
const composeStarted = new Error('compose up reached');

vi.mock('./install-command.js', async (original) => {
  const actual = await original<typeof import('./install-command.js')>();
  return {
    ...actual,
    installCommand: vi.fn(async (command: string, args: string[], options: { label: string; absentHint?: string }) => {
      engine.calls.push([command, ...args]);
      const absent = () => {
        throw new actual.InstallCommandFailure(`${options.label}: ${options.absentHint ?? 'failed (exit 1)'}`);
      };
      if (command === 'git' || command === 'python3') return '';
      if (command !== 'docker') throw new Error(`unexpected command: ${command}`);
      if (args[0] === 'version') return 'arm64\n';
      if (args[0] === 'buildx') return engine.buildx ? '' : absent();
      if (args[0] === 'build') return '';
      if (args[0] === 'image' && args[1] === 'inspect') {
        const built = engine.calls.some((call) => call.includes('build') && call.includes(args[2]));
        if (!built) return absent();
        return args.includes('--format') ? `arm64 ${'0'.repeat(40)}` : `sha256:${'b'.repeat(64)}`;
      }
      if (args[0] === 'volume') return '';
      if (args[0] === 'compose') throw composeStarted;
      throw new Error(`unexpected command: docker ${args.join(' ')}`);
    }),
  };
});

const { run } = await import('./setup.js');
const { controlPaths } = await import('./control.js');

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const roots: string[] = [];

beforeEach(() => {
  engine.calls.length = 0;
  engine.emulation = false;
  engine.buildx = true;
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

const dockerVerbs = () => engine.calls.filter((call) => call[0] === 'docker').map((call) => call.slice(1, 3).join(' '));
const webService = (root: string) => yaml(fs.readFileSync(controlPaths(root).compose, 'utf8')).services.web;

describe('Iron Proxy setup on an arm64 Linux engine', () => {
  it('keeps the pinned amd64 console image where QEMU emulation is registered', async () => {
    engine.emulation = true;
    const root = project();
    await expect(run(['--with-control'], root)).rejects.toBe(composeStarted);
    const verbs = dockerVerbs();
    expect(verbs.filter((verb) => verb.startsWith('buildx'))).toEqual([]);
    expect(verbs.filter((verb) => verb.startsWith('build'))).toHaveLength(1);
    const web = webService(root);
    expect(web.image).toMatch(/^docker.io\/ironsh\/iron-control:.*@sha256:[a-f0-9]{64}$/);
    expect(web.platform).toBe('linux/amd64');
    expect(web.pull_policy).toBeUndefined();
  });

  it('builds the console natively before the proxy where nothing emulates amd64', async () => {
    const root = project();
    await expect(run(['--with-control'], root)).rejects.toBe(composeStarted);
    const verbs = dockerVerbs();
    expect(verbs.indexOf('buildx build')).toBeGreaterThanOrEqual(0);
    expect(verbs.indexOf('buildx build')).toBeLessThan(verbs.indexOf('build -f'));
    const build = engine.calls.find((call) => call[1] === 'buildx' && call[2] === 'build')!;
    expect(build.slice(3, 6)).toEqual(['--platform', 'linux/arm64', '--load']);
    const web = webService(root);
    expect(web.image).toMatch(/^nanoclaw-iron-control:[0-9a-f]{7}-arm64$/);
    expect(web.platform).toBe('linux/arm64');
    expect(web.pull_policy).toBe('never');
  });

  it('stops with the documented options before building or fetching anything without Buildx', async () => {
    engine.buildx = false;
    const root = project();
    const failure = await run(['--with-control'], root).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(InstallCommandFailure);
    const message = (failure as Error).message;
    expect(message).toContain('Iron Control has no arm64 image');
    expect(message).toMatch(
      /docker run --privileged --rm docker\.io\/tonistiigi\/binfmt:\S+@sha256:[0-9a-f]{64} --install amd64/,
    );
    expect(message).toContain('Install Docker Buildx');
    expect(message).toContain('OneCLI gateway');
    // Only probes ran: the engine architecture, the cached console image, Buildx.
    expect(dockerVerbs()).toEqual(['version --format', 'image inspect', 'buildx version']);
    expect(engine.calls.some((call) => call[0] === 'git' || call[0] === 'python3')).toBe(false);
    expect(fs.existsSync(controlPaths(root).compose)).toBe(false);
  });
});
