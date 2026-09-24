import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AMD64_EMULATION_COMMAND,
  detectControlHost,
  ensureControlImage,
  localControlImageTag,
  pinnedControlImage,
  planControlImage,
  readControlImageRecord,
  type ControlHost,
  type Exec,
} from './control-image.js';
import { InstallCommandFailure } from './install-command.js';

const pins = JSON.parse(fs.readFileSync(new URL('../versions.json', import.meta.url), 'utf8')) as Record<
  string,
  string
>;
const commit = pins['iron-control-commit'];

const roots: string[] = [];
const temporary = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-control-image-test-'));
  roots.push(root);
  return { image: path.join(root, 'image.json'), compose: path.join(root, 'compose.yaml') };
};
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Engine {
  arch?: string;
  buildx?: boolean;
  /** Revision label of an already built local image, or none. */
  built?: string;
}

/** A Docker engine and Git that answer like the real install commands, without running anything. */
function fakeExec(engine: Engine) {
  const calls: string[][] = [];
  const exec: Exec = async (command, args, options) => {
    calls.push([command, ...args]);
    const absent = () => {
      throw new InstallCommandFailure(`${options.label}: ${options.absentHint ?? 'failed (exit 1)'}`);
    };
    if (command === 'git') return '';
    if (args[0] === 'version') return `${engine.arch ?? 'arm64'}\n`;
    if (args[0] === 'buildx') return engine.buildx === false ? absent() : 'github.com/docker/buildx v0.31.1';
    if (args[0] === 'build') {
      engine.built = commit;
      expect(fs.existsSync(args.at(-1)!)).toBe(true);
      return '';
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      if (!engine.built) return absent();
      return args.includes('{{.Id}}') ? `sha256:${'a'.repeat(64)}\n` : `${engine.built}\n`;
    }
    if (args[0] === 'run') return '';
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  return { exec, calls };
}

const host = (overrides: Partial<ControlHost>): ControlHost => ({
  arch: 'arm64',
  canBuild: true,
  hasEmulation: false,
  hasLocalBuild: false,
  ...overrides,
});

describe('Iron Control image decision table', () => {
  it('keeps amd64 on the pinned image and digest whatever else the engine offers', () => {
    for (const previous of [undefined, 'local-build', 'pinned-emulated'] as const) {
      const plan = planControlImage(host({ arch: 'amd64', canBuild: false, hasEmulation: false }), previous);
      expect(plan).toEqual({ ok: true, image: pinnedControlImage() });
    }
    expect(pinnedControlImage()).toEqual({
      source: 'pinned',
      image: pins['iron-control-image'],
      platform: 'linux/amd64',
      arch: 'amd64',
    });
    expect(pins['iron-control-image']).toMatch(
      /^docker\.io\/ironsh\/iron-control:sha-[0-9a-f]{7}@sha256:[0-9a-f]{64}$/,
    );
  });

  it('builds the pinned source natively when the engine can build', () => {
    const plan = planControlImage(host({}));
    expect(plan.ok && plan.image).toEqual({
      source: 'local-build',
      image: `nanoclaw-iron-control:${commit.slice(0, 7)}-arm64`,
      arch: 'arm64',
    });
    expect(plan.ok && plan.note).toContain('building it from the pinned source');
    expect(localControlImageTag('riscv64')).toBe(`nanoclaw-iron-control:${commit.slice(0, 7)}-riscv64`);
  });

  it('reuses an image already built here, even without buildx', () => {
    const plan = planControlImage(host({ canBuild: false, hasLocalBuild: true }));
    expect(plan.ok && plan.image.source).toBe('local-build');
    expect(plan.ok && plan.note).toContain('built on this machine');
  });

  it('falls back to the emulated pinned image only when it cannot build', () => {
    const plan = planControlImage(host({ canBuild: false, hasEmulation: true }));
    expect(plan.ok && plan.image).toEqual({
      source: 'pinned-emulated',
      image: pins['iron-control-image'],
      platform: 'linux/amd64',
      arch: 'arm64',
    });
    const canBuild = planControlImage(host({ hasEmulation: true }));
    expect(canBuild.ok && canBuild.image.source).toBe('local-build');
  });

  it('keeps an install that already runs emulated on emulation while it works', () => {
    const kept = planControlImage(host({ hasEmulation: true }), 'pinned-emulated');
    expect(kept.ok && kept.image.source).toBe('pinned-emulated');
    const lost = planControlImage(host({ hasEmulation: false }), 'pinned-emulated');
    expect(lost.ok && lost.image.source).toBe('local-build');
    const rebuilt = planControlImage(host({ hasLocalBuild: false }), 'local-build');
    expect(rebuilt.ok && rebuilt.image.source).toBe('local-build');
  });

  it('stops before any pull with both options when it can neither build nor emulate', () => {
    const plan = planControlImage(host({ canBuild: false, hasEmulation: false }));
    expect(plan.ok).toBe(false);
    const message = plan.ok ? '' : plan.message;
    expect(message).toContain('arm64');
    expect(message).toContain(AMD64_EMULATION_COMMAND);
    expect(message).toContain('OneCLI');
    expect(message).toContain('buildx');
  });
});

describe('Iron Control engine detection', () => {
  it('asks Docker for its architecture and probes nothing else on amd64', async () => {
    const { exec, calls } = fakeExec({ arch: 'amd64' });
    expect(await detectControlHost({ exec })).toEqual({
      arch: 'amd64',
      canBuild: true,
      hasEmulation: true,
      hasLocalBuild: false,
    });
    expect(calls).toEqual([['docker', 'version', '--format', '{{.Server.Arch}}']]);
  });

  it('reports buildx and a matching local build on another architecture', async () => {
    const withBuildx = fakeExec({ arch: 'arm64', buildx: true, built: commit });
    expect(await detectControlHost({ exec: withBuildx.exec, emulation: () => false })).toEqual({
      arch: 'arm64',
      canBuild: true,
      hasEmulation: false,
      hasLocalBuild: true,
    });
    expect(withBuildx.calls[2]).toEqual([
      'docker',
      'image',
      'inspect',
      `nanoclaw-iron-control:${commit.slice(0, 7)}-arm64`,
      '--format',
      '{{index .Config.Labels "org.opencontainers.image.revision"}}',
    ]);
    const without = fakeExec({ arch: 'arm64', buildx: false, built: 'stale-revision' });
    expect(await detectControlHost({ exec: without.exec, emulation: () => true })).toEqual({
      arch: 'arm64',
      canBuild: false,
      hasEmulation: true,
      hasLocalBuild: false,
    });
  });

  it('refuses an engine that does not answer', async () => {
    const exec: Exec = async () => '\n';
    await expect(detectControlHost({ exec })).rejects.toThrow('did not report its engine architecture');
  });
});

describe('Iron Control image preflight', () => {
  it('leaves amd64 untouched: no build, no record', async () => {
    const paths = temporary();
    const { exec, calls } = fakeExec({ arch: 'amd64' });
    expect(await ensureControlImage(paths, { exec, report: () => {} })).toEqual(pinnedControlImage());
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(paths.image)).toBe(false);
  });

  it('builds the pinned revision natively on a fresh arm64 install and records it', async () => {
    const paths = temporary();
    const engine = fakeExec({ arch: 'arm64', buildx: true });
    const lines: string[] = [];
    const image = await ensureControlImage(paths, {
      exec: engine.exec,
      emulation: () => false,
      report: (l) => lines.push(l),
    });
    expect(image).toEqual({
      source: 'local-build',
      image: `nanoclaw-iron-control:${commit.slice(0, 7)}-arm64`,
      arch: 'arm64',
    });
    expect(engine.calls).toContainEqual(['git', 'fetch', '--depth', '1', 'origin', commit]);
    expect(engine.calls).toContainEqual(['git', 'diff', '--exit-code']);
    const build = engine.calls.find((call) => call[1] === 'build')!;
    expect(build.slice(0, 7)).toEqual([
      'docker',
      'build',
      '-t',
      `nanoclaw-iron-control:${commit.slice(0, 7)}-arm64`,
      '--label',
      `org.opencontainers.image.revision=${commit}`,
      '--label',
    ]);
    expect(engine.calls.some((call) => call[1] === 'pull' || call[1] === 'run')).toBe(false);
    expect(lines.join('\n')).toContain('building it from the pinned source');
    const record = readControlImageRecord(paths.image)!;
    expect(record).toMatchObject({ source: 'local-build', arch: 'arm64', commit, imageId: `sha256:${'a'.repeat(64)}` });
    expect(fs.statSync(paths.image).mode & 0o777).toBe(0o600);
  });

  it('reuses the recorded local build on a re-run without building again', async () => {
    const paths = temporary();
    const first = fakeExec({ arch: 'arm64', buildx: true });
    await ensureControlImage(paths, { exec: first.exec, emulation: () => false, report: () => {} });
    const again = fakeExec({ arch: 'arm64', buildx: false, built: commit });
    const image = await ensureControlImage(paths, { exec: again.exec, emulation: () => true, report: () => {} });
    expect(image.source).toBe('local-build');
    expect(again.calls.some((call) => call[0] === 'git' || call[1] === 'build')).toBe(false);
  });

  it('keeps an install from before this record on the emulated pinned image', async () => {
    const paths = temporary();
    fs.writeFileSync(paths.compose, 'name: existing\n');
    const engine = fakeExec({ arch: 'arm64', buildx: true });
    const image = await ensureControlImage(paths, { exec: engine.exec, emulation: () => true, report: () => {} });
    expect(image).toEqual({
      source: 'pinned-emulated',
      image: pins['iron-control-image'],
      platform: 'linux/amd64',
      arch: 'arm64',
    });
    expect(engine.calls.some((call) => call[1] === 'build')).toBe(false);
    expect(readControlImageRecord(paths.image)).toMatchObject({ source: 'pinned-emulated', arch: 'arm64' });
    // Without emulation the old install cannot have worked; build natively instead.
    const rebuilt = fakeExec({ arch: 'arm64', buildx: true });
    fs.rmSync(paths.image);
    expect(
      (await ensureControlImage(paths, { exec: rebuilt.exec, emulation: () => false, report: () => {} })).source,
    ).toBe('local-build');
  });

  it('stops a headless run with the exact commands and touches nothing', async () => {
    const paths = temporary();
    const engine = fakeExec({ arch: 'arm64', buildx: false });
    await expect(
      ensureControlImage(paths, { exec: engine.exec, emulation: () => false, report: () => {} }),
    ).rejects.toThrow(AMD64_EMULATION_COMMAND);
    expect(engine.calls.some((call) => call[1] === 'run' || call[1] === 'build' || call[1] === 'pull')).toBe(false);
    expect(fs.existsSync(paths.image)).toBe(false);
  });

  it('registers emulation only with consent, then keeps the pinned image', async () => {
    const paths = temporary();
    const engine = fakeExec({ arch: 'arm64', buildx: false });
    let registered = false;
    const declined = ensureControlImage(paths, {
      exec: engine.exec,
      emulation: () => registered,
      confirmEmulation: async () => false,
      report: () => {},
    });
    await expect(declined).rejects.toThrow('OneCLI');
    expect(engine.calls.some((call) => call[1] === 'run')).toBe(false);
    const asked: string[] = [];
    const image = await ensureControlImage(paths, {
      exec: engine.exec,
      emulation: () => registered,
      confirmEmulation: async (command) => {
        asked.push(command);
        registered = true;
        return true;
      },
      report: () => {},
    });
    expect(asked).toEqual([AMD64_EMULATION_COMMAND]);
    expect(engine.calls).toContainEqual([
      'docker',
      'run',
      '--privileged',
      '--rm',
      'tonistiigi/binfmt',
      '--install',
      'amd64',
    ]);
    expect(image.source).toBe('pinned-emulated');
    expect(readControlImageRecord(paths.image)?.source).toBe('pinned-emulated');
  });

  it('ignores a record made for another architecture or malformed on disk', async () => {
    const paths = temporary();
    fs.writeFileSync(paths.image, JSON.stringify({ source: 'pinned-emulated', arch: 'riscv64', image: 'x' }));
    const engine = fakeExec({ arch: 'arm64', buildx: true });
    expect(
      (await ensureControlImage(paths, { exec: engine.exec, emulation: () => true, report: () => {} })).source,
    ).toBe('local-build');
    fs.writeFileSync(paths.image, '{not json');
    expect(readControlImageRecord(paths.image)).toBeUndefined();
    fs.writeFileSync(paths.image, JSON.stringify({ source: 'other', arch: 'arm64', image: 'x' }));
    expect(readControlImageRecord(paths.image)).toBeUndefined();
  });
});
