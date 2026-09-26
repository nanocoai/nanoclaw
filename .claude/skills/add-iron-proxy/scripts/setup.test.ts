import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as yaml } from 'yaml';

import { InstallCommandFailure } from './install-command.js';

/**
 * A fresh arm64 engine whose Docker CLI has no Buildx plugin and no cached
 * images. Without Buildx, `docker build` is the legacy builder, which rejects
 * BuildKit-only Dockerfile syntax.
 */
const engine = { emulation: false, calls: [] as string[][] };

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
      if (args[0] === 'buildx') return absent();
      if (args[0] === 'build') {
        const dockerfile = fs.readFileSync(args[args.indexOf('-f') + 1], 'utf8');
        const buildkitOnly = dockerfile.match(/^\s*(?:COPY|ADD|RUN)\b.*(?:--chmod|--link|--mount|--parents|<<)/m);
        if (buildkitOnly) throw new actual.InstallCommandFailure(`legacy builder rejects: ${buildkitOnly[0].trim()}`);
        return '';
      }
      if (args[0] === 'image' && args[1] === 'inspect') {
        const built = engine.calls.some(
          (call) => call[1] === 'build' && call.includes(args[2]) && !call.includes('buildx'),
        );
        if (!built) return absent();
        return `sha256:${'b'.repeat(64)}`;
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

describe('Iron Proxy setup on an arm64 engine without Buildx', () => {
  it('stops with the documented options before building or fetching anything', async () => {
    // Linux without a QEMU amd64 handler: no Buildx, no emulation, nothing cached.
    const root = project();
    const failure = await run(['--with-control'], root).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(InstallCommandFailure);
    const message = (failure as Error).message;
    expect(message).toContain('Iron Control has no arm64 image');
    expect(message).toContain('Install Docker Buildx');
    expect(message).toContain('docker run --privileged --rm tonistiigi/binfmt --install amd64');
    expect(message).toContain('OneCLI gateway');
    expect(dockerVerbs()).not.toContain('build');
    expect(dockerVerbs()).not.toContain('compose');
    expect(engine.calls.some((call) => call[0] === 'git' || call[0] === 'python3')).toBe(false);
    expect(fs.existsSync(controlPaths(root).image)).toBe(false);
  });

  it('builds Iron Proxy with the legacy builder and starts the console emulated', async () => {
    // Linux with QEMU amd64 emulation registered, but no Buildx.
    engine.emulation = true;
    const root = project();
    await expect(run(['--with-control'], root)).rejects.toBe(composeStarted);
    const verbs = dockerVerbs();
    expect(verbs.indexOf('buildx')).toBeLessThan(verbs.indexOf('build'));
    const web = yaml(fs.readFileSync(controlPaths(root).compose, 'utf8')).services.web;
    expect(web.platform).toBe('linux/amd64');
    expect(JSON.parse(fs.readFileSync(controlPaths(root).image, 'utf8')).source).toBe('pinned-emulated');
  });
});
