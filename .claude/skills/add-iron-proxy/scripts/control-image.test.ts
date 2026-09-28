import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as yaml } from 'yaml';

import {
  AMD64_EMULATION_COMMAND,
  blockedControlImageMessage,
  detectControlHost,
  ensureControlImage,
  hasAmd64Emulation,
  localControlImage,
  pinnedControlImage,
  planControlImage,
  type Exec,
} from './control-image.js';
import { controlCompose } from './control.js';
import { InstallCommandFailure } from './install-command.js';

const pins = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'versions.json'), 'utf8'),
) as Record<string, string>;

/** A Docker engine described by architecture, Buildx, and which images it already holds. */
function engine(spec: { arch: string; buildx: boolean; images?: Record<string, string>; diesAfter?: number }) {
  const calls: string[][] = [];
  const images = { ...(spec.images ?? {}) };
  const exec: Exec = async (command, args, options) => {
    calls.push([command, ...args]);
    const absent = () => {
      throw new InstallCommandFailure(`${options.label}: ${options.absentHint ?? 'failed (exit 1)'}`);
    };
    if (
      spec.diesAfter !== undefined &&
      command === 'docker' &&
      calls.filter((c) => c[0] === 'docker').length > spec.diesAfter
    )
      throw new InstallCommandFailure(`${options.label} failed (exit 1). ${options.failureHint ?? ''}`.trim());
    if (command === 'git') return '';
    if (command !== 'docker') throw new Error(`unexpected command: ${command}`);
    if (args[0] === 'version') return `${spec.arch}\n`;
    if (args[0] === 'buildx' && args[1] === 'version')
      return spec.buildx ? 'github.com/docker/buildx v0.31.1' : absent();
    if (args[0] === 'buildx' && args[1] === 'build') {
      if (!spec.buildx) return absent();
      const tag = args[args.indexOf('-t') + 1];
      const arch = args[args.indexOf('--platform') + 1].replace('linux/', '');
      const revision = args.find((arg) => arg.startsWith('org.opencontainers.image.revision='))!.split('=')[1];
      images[tag] = `${arch} ${revision}`;
      return '';
    }
    if (args[0] === 'image' && args[1] === 'inspect') return images[args[2]] ?? absent();
    throw new Error(`unexpected command: docker ${args.join(' ')}`);
  };
  return { calls, images, exec };
}

describe('Iron Control image per engine', () => {
  it('keeps the pinned image and digest on amd64 and wherever amd64 runs under emulation', () => {
    expect(planControlImage({ arch: 'amd64', hasEmulation: true })).toEqual({ image: pinnedControlImage() });
    const emulated = planControlImage({ arch: 'arm64', hasEmulation: true });
    expect(emulated.image).toEqual(pinnedControlImage());
    expect(emulated.note).toContain('under emulation');
    expect(pinnedControlImage()).toEqual({
      source: 'pinned',
      image: pins['iron-control-image'],
      platform: 'linux/amd64',
    });
  });

  it('builds natively only where the engine cannot emulate amd64', () => {
    const plan = planControlImage({ arch: 'arm64', hasEmulation: false });
    expect(plan.image).toEqual(localControlImage('arm64'));
    expect(plan.image).toEqual({
      source: 'local-build',
      image: `nanoclaw-iron-control:${pins['iron-control-commit'].slice(0, 7)}-arm64`,
      platform: 'linux/arm64',
    });
    expect(plan.note).toContain('building it from the pinned source');
  });

  it('pins the printed emulation command by digest and never runs it', () => {
    expect(pins['amd64-emulation-image']).toMatch(/^docker\.io\/tonistiigi\/binfmt:[a-z0-9.-]+@sha256:[0-9a-f]{64}$/);
    expect(AMD64_EMULATION_COMMAND).toBe(
      `docker run --privileged --rm ${pins['amd64-emulation-image']} --install amd64`,
    );
    const message = blockedControlImageMessage('arm64');
    expect(message).toContain(AMD64_EMULATION_COMMAND);
    expect(message).toContain('Install Docker Buildx');
    expect(message).toContain('OneCLI gateway');
  });
});

describe('amd64 emulation probe', () => {
  const files = (status: string, handler?: string) => (file: string) => {
    if (file === '/proc/sys/fs/binfmt_misc/status') return status;
    if (file === '/proc/sys/fs/binfmt_misc/qemu-x86_64' && handler !== undefined) return handler;
    throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  };
  const registered = 'enabled\ninterpreter /usr/bin/qemu-x86_64\nflags: POCF\noffset 0\n';

  it('trusts Docker Desktop off Linux', () => {
    expect(hasAmd64Emulation('darwin', files('disabled'))).toBe(true);
    expect(hasAmd64Emulation('win32', files('disabled'))).toBe(true);
  });

  it('needs a registered, enabled qemu-x86_64 handler with the F flag on Linux', () => {
    expect(hasAmd64Emulation('linux', files('enabled', registered))).toBe(true);
    expect(hasAmd64Emulation('linux', files('enabled'))).toBe(false);
    expect(hasAmd64Emulation('linux', files('disabled', registered))).toBe(false);
    expect(hasAmd64Emulation('linux', files('enabled', registered.replace('enabled', 'disabled')))).toBe(false);
    expect(hasAmd64Emulation('linux', files('enabled', registered.replace('POCF', 'POC')))).toBe(false);
    expect(hasAmd64Emulation('linux', files('enabled', 'enabled\ninterpreter /x\n'))).toBe(false);
  });
});

describe('ensureControlImage', () => {
  const notLinux = () => true;
  const noBinfmt = () => false;

  it('asks Docker for its architecture only, on amd64', async () => {
    const docker = engine({ arch: 'amd64', buildx: true });
    const image = await ensureControlImage({ exec: docker.exec, emulation: noBinfmt, report: () => {} });
    expect(image).toEqual(pinnedControlImage());
    expect(docker.calls).toEqual([['docker', 'version', '--format', '{{.Server.Arch}}']]);
  });

  it('rejects an engine that reports no architecture', async () => {
    const exec: Exec = async () => '';
    await expect(ensureControlImage({ exec, emulation: notLinux })).rejects.toThrow(
      'did not report its engine architecture',
    );
    expect(await detectControlHost({ exec: async () => 'arm64\n', emulation: noBinfmt })).toEqual({
      arch: 'arm64',
      hasEmulation: false,
    });
  });

  it('runs the pinned image under emulation without touching Buildx or building', async () => {
    const docker = engine({ arch: 'arm64', buildx: false });
    const notes: string[] = [];
    const image = await ensureControlImage({ exec: docker.exec, emulation: notLinux, report: (l) => notes.push(l) });
    expect(image).toEqual(pinnedControlImage());
    expect(docker.calls).toHaveLength(1);
    expect(notes.join('\n')).toContain('under emulation');
  });

  it('builds the pinned revision natively once and reuses it', async () => {
    const docker = engine({ arch: 'arm64', buildx: true });
    const notes: string[] = [];
    const image = await ensureControlImage({ exec: docker.exec, emulation: noBinfmt, report: (l) => notes.push(l) });
    expect(image).toEqual(localControlImage('arm64'));
    const build = docker.calls.find((call) => call[1] === 'buildx' && call[2] === 'build')!;
    expect(build.slice(1, 7)).toEqual(['buildx', 'build', '--platform', 'linux/arm64', '--load', '-t']);
    expect(build[7]).toBe(image.image);
    expect(build).toContain(`org.opencontainers.image.revision=${pins['iron-control-commit']}`);
    expect(docker.calls.filter((call) => call[0] === 'git').map((call) => call[1])).toEqual([
      'init',
      'remote',
      'fetch',
      'checkout',
      'diff',
    ]);
    expect(docker.calls.find((call) => call[1] === 'fetch')).toContain(pins['iron-control-commit']);
    // Same engine, next run: the image matches, nothing is fetched or built again.
    docker.calls.length = 0;
    expect(await ensureControlImage({ exec: docker.exec, emulation: noBinfmt, report: (l) => notes.push(l) })).toEqual(
      image,
    );
    expect(docker.calls.map((call) => call.slice(0, 3))).toEqual([
      ['docker', 'version', '--format'],
      ['docker', 'image', 'inspect'],
    ]);
    expect(notes.at(-1)).toContain('built on this machine');
  });

  it('rebuilds when the cached tag is another architecture or revision', async () => {
    const tag = localControlImage('arm64').image;
    for (const stale of ['amd64 ' + pins['iron-control-commit'], 'arm64 0000000']) {
      const docker = engine({ arch: 'arm64', buildx: true, images: { [tag]: stale } });
      await ensureControlImage({ exec: docker.exec, emulation: noBinfmt, report: () => {} });
      expect(docker.calls.some((call) => call[1] === 'buildx' && call[2] === 'build')).toBe(true);
    }
  });

  it('stops with the options before any fetch when it can neither emulate nor build', async () => {
    const docker = engine({ arch: 'arm64', buildx: false });
    await expect(ensureControlImage({ exec: docker.exec, emulation: noBinfmt, report: () => {} })).rejects.toThrow(
      blockedControlImageMessage('arm64'),
    );
    expect(docker.calls.some((call) => call[0] === 'git' || call[2] === 'build')).toBe(false);
  });

  it('reports Docker itself failing instead of a missing Buildx plugin', async () => {
    // The architecture check passes, then every docker call fails (a broken CLI
    // or socket): the failed Buildx probe alone would read as a missing plugin.
    const docker = engine({ arch: 'arm64', buildx: true, diesAfter: 1 });
    const failure = await ensureControlImage({ exec: docker.exec, emulation: noBinfmt, report: () => {} }).catch(
      (error: unknown) => error as Error,
    );
    expect(failure.message).toContain('Check that Docker is still reachable');
    expect(failure.message).toContain('Docker is running and reachable');
    expect(failure.message).not.toContain('buildx is unavailable');
    expect(docker.calls.at(-1)?.slice(0, 2)).toEqual(['docker', 'version']);
  });

  it('propagates an interrupted probe instead of treating it as absent', async () => {
    const exec: Exec = async (command, args) => {
      if (args[0] === 'version') return 'arm64\n';
      throw new InstallCommandFailure('cancelled', true);
    };
    await expect(ensureControlImage({ exec, emulation: noBinfmt, report: () => {} })).rejects.toThrow('cancelled');
  });
});

describe('Iron Control compose per console image', () => {
  const roots: string[] = [];
  const temporary = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-control-image-test-'));
    roots.push(root);
    return root;
  };
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes the pinned amd64 image and platform byte for byte by default', () => {
    const root = temporary();
    const text = controlCompose(root, 18443);
    expect(text).toBe(controlCompose(root, 18443, pinnedControlImage()));
    const web = yaml(text).services.web;
    expect(Object.keys(web).slice(0, 3)).toEqual(['image', 'platform', 'restart']);
    expect(web.image).toBe(pins['iron-control-image']);
    expect(web.platform).toBe('linux/amd64');
    expect(web.pull_policy).toBeUndefined();
  });

  it('runs a locally built image on its native platform and never pulls it', () => {
    const root = temporary();
    const config = yaml(controlCompose(root, 18443, localControlImage('arm64')));
    expect(config.services.web.image).toMatch(/^nanoclaw-iron-control:[0-9a-f]{7}-arm64$/);
    // Explicit so DOCKER_DEFAULT_PLATFORM cannot make Compose ask for amd64.
    expect(config.services.web.platform).toBe('linux/arm64');
    expect(config.services.web.pull_policy).toBe('never');
    // Everything else stays as on amd64: loopback port, env files, database.
    const pinned = yaml(controlCompose(root, 18443));
    const { image: _i, platform: _p, ...pinnedWeb } = pinned.services.web;
    const { image: _j, platform: _k, pull_policy: _q, ...localWeb } = config.services.web;
    expect(localWeb).toEqual(pinnedWeb);
    expect(config.services.database).toEqual(pinned.services.database);
  });
});
