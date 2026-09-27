import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getInstallSlug, getLaunchdLabel, getSystemdUnit } from '../../src/install-slug.js';
import { detectExistingInstall, ironControlProject, scanInstall, type RunCommand, type ScanDeps } from './scan.js';

let root: string;
let home: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-scan-root-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-scan-home-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

/** Fake runCommand: unhandled commands fail (binary missing / daemon down). */
function fakeRun(handlers: Record<string, (args: string[]) => { status: number | null; stdout: string }>): RunCommand {
  return (cmd, args) => (handlers[cmd] ?? (() => ({ status: 1, stdout: '' })))(args);
}

function deps(overrides: Partial<ScanDeps> = {}): ScanDeps {
  return {
    projectRoot: root,
    home,
    platform: 'darwin',
    runCommand: fakeRun({}),
    ...overrides,
  };
}

const dockerUp = (containerIds: string[], hasImage: boolean) =>
  fakeRun({
    docker: (args) => {
      if (args[0] === 'ps' && args.some((a) => a.startsWith('label=nanoclaw-install=')))
        return { status: 0, stdout: containerIds.join('\n') + '\n' };
      if (args[0] === 'ps' || args[1] === 'ls') return { status: 0, stdout: '' };
      if (args[0] === 'image') return { status: hasImage ? 0 : 1, stdout: '' };
      return { status: 1, stdout: '' };
    },
  });

describe('scanInstall path groups', () => {
  it('puts dist and node_modules in runtime, not data', () => {
    for (const dir of ['data', 'logs', 'dist', 'node_modules', 'groups', 'store']) {
      fs.mkdirSync(path.join(root, dir));
    }
    fs.writeFileSync(path.join(root, '.env'), 'KEY=v');
    fs.writeFileSync(path.join(root, 'start-nanoclaw.sh'), '#!/bin/bash');
    const updates = path.join(path.dirname(root), '.nanoclaw-updates', getInstallSlug(root));
    fs.mkdirSync(updates, { recursive: true });

    const inv = scanInstall(deps());

    expect(inv.data.map((i) => path.basename(i.path))).toEqual([
      'data',
      'logs',
      '.env',
      'start-nanoclaw.sh',
      getInstallSlug(root),
    ]);
    expect(inv.data.at(-1)).toMatchObject({ what: 'Update rollback snapshots', path: updates });
    fs.rmSync(updates, { recursive: true, force: true });
    expect(inv.runtime.map((i) => path.basename(i.path))).toEqual(['dist', 'node_modules']);
    expect(inv.user.map((i) => path.basename(i.path))).toEqual(['groups', 'store']);
  });

  it('finds nothing in an empty checkout', () => {
    const inv = scanInstall(deps());
    expect(inv.data).toEqual([]);
    expect(inv.runtime).toEqual([]);
    expect(inv.user).toEqual([]);
    expect(inv.service.containerIds).toEqual([]);
    expect(inv.service.image).toBeUndefined();
  });
});

describe('scanInstall service artifacts', () => {
  it('detects the launchd plist on macOS', () => {
    const plist = path.join(home, 'Library', 'LaunchAgents', `${getLaunchdLabel(root)}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, '<plist/>');

    const inv = scanInstall(deps());
    expect(inv.service.launchdPlist).toBe(plist);
    expect(inv.service.systemdUserUnit).toBeUndefined();
  });

  it('detects systemd user unit and pidfile on Linux', () => {
    const unit = path.join(home, '.config', 'systemd', 'user', `${getSystemdUnit(root)}.service`);
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, '[Unit]');
    fs.writeFileSync(path.join(root, 'nanoclaw.pid'), '12345');

    const inv = scanInstall(deps({ platform: 'linux' }));
    expect(inv.service.systemdUserUnit).toBe(unit);
    expect(inv.service.pidFile).toBe(path.join(root, 'nanoclaw.pid'));
    expect(inv.service.launchdPlist).toBeUndefined();
  });

  it('captures container ids and image when docker is up', () => {
    const inv = scanInstall(deps({ runCommand: dockerUp(['abc123', 'def456'], true) }));
    expect(inv.service.containerIds).toEqual(['abc123', 'def456']);
    expect(inv.service.image).toMatch(/^nanoclaw-agent-v2-[0-9a-f]{8}:latest$/);
    expect(inv.notes).toEqual([]);
    expect(inv.ironControl).toBeUndefined();
  });

  it('degrades with a manual-cleanup note when docker is unavailable', () => {
    const inv = scanInstall(deps());
    expect(inv.service.containerIds).toEqual([]);
    expect(inv.service.image).toBeUndefined();
    expect(inv.notes.some((n) => n.includes("'docker' unavailable"))).toBe(true);
  });
});

describe('scanInstall Iron Control', () => {
  /** Docker holding this install's Iron Control objects next to another copy's. */
  const ironDocker = (ours: { ids: string[]; volume: boolean; network: boolean }, failVolumes = false) => {
    const project = ironControlProject(getInstallSlug(root));
    const other = ironControlProject('ffffffff');
    return fakeRun({
      docker: (args) => {
        if (args[0] === 'ps' && args.includes(`label=com.docker.compose.project=${project}`))
          return { status: 0, stdout: ours.ids.join('\n') + '\n' };
        if (args[0] === 'ps') return { status: 0, stdout: '' };
        if (args[0] === 'volume')
          return failVolumes
            ? { status: 1, stdout: '' }
            : { status: 0, stdout: [`${other}_database`, ...(ours.volume ? [`${project}_database`] : [])].join('\n') };
        if (args[0] === 'network')
          return { status: 0, stdout: ['bridge', other, ...(ours.network ? [project] : [])].join('\n') };
        return { status: 1, stdout: '' };
      },
    });
  };

  it("lists only this install's project, volume and network", () => {
    const project = ironControlProject(getInstallSlug(root));
    const inv = scanInstall(deps({ runCommand: ironDocker({ ids: ['web1', 'db1'], volume: true, network: true }) }));
    expect(inv.ironControl).toEqual({
      project,
      containerIds: ['web1', 'db1'],
      volume: `${project}_database`,
      network: project,
    });
  });

  it('finds an orphaned volume with no containers left', () => {
    const inv = scanInstall(deps({ runCommand: ironDocker({ ids: [], volume: true, network: false }) }));
    expect(inv.ironControl).toMatchObject({ containerIds: [], volume: expect.stringMatching(/_database$/) });
    expect(inv.ironControl?.network).toBeUndefined();
  });

  it("reports nothing when only another copy's objects exist", () => {
    const inv = scanInstall(deps({ runCommand: ironDocker({ ids: [], volume: false, network: false }) }));
    expect(inv.ironControl).toBeUndefined();
  });

  it('never reads a failed volume listing as "no volume"', () => {
    const inv = scanInstall(deps({ runCommand: ironDocker({ ids: ['web1'], volume: true, network: true }, true) }));
    expect(inv.ironControl).toBeUndefined();
    expect(inv.notes.some((n) => n.startsWith('Iron Control (if installed)'))).toBe(true);
  });

  it('notes the manual commands when docker is unavailable', () => {
    const inv = scanInstall(deps());
    expect(inv.ironControl).toBeUndefined();
    const project = ironControlProject(getInstallSlug(root));
    expect(
      inv.notes.some((n) => n.includes(`docker volume rm ${project}_database; docker network rm ${project}`)),
    ).toBe(true);
  });
});

describe('scanInstall ncl symlink', () => {
  const link = () => path.join(home, '.local', 'bin', 'ncl');

  it('includes the symlink only when it targets this checkout', () => {
    fs.mkdirSync(path.dirname(link()), { recursive: true });
    fs.symlinkSync(path.join(root, 'bin', 'ncl'), link());

    const inv = scanInstall(deps());
    expect(inv.service.nclSymlink).toBe(link());
  });

  it('leaves a symlink pointing at another copy, with a note', () => {
    fs.mkdirSync(path.dirname(link()), { recursive: true });
    fs.symlinkSync('/some/other/copy/bin/ncl', link());

    const inv = scanInstall(deps());
    expect(inv.service.nclSymlink).toBeUndefined();
    expect(inv.notes.some((n) => n.includes('points to another NanoClaw copy'))).toBe(true);
  });
});

describe('detectExistingInstall', () => {
  it('is false for an empty checkout', () => {
    expect(detectExistingInstall(root)).toBe(false);
  });

  it('is true when the central DB exists', () => {
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data', 'v2.db'), '');
    expect(detectExistingInstall(root)).toBe(true);
  });
});
