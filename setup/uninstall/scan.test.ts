import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getInstallSlug, getLaunchdLabel, getSystemdUnit } from '../../src/install-slug.js';
import { COMPOSE_PROJECT_LABEL, detectExistingInstall, scanInstall, type RunCommand, type ScanDeps } from './scan.js';

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
      if (args[0] === 'ps' && args.some((a) => a.startsWith('label=nanoclaw-install='))) {
        // Agent containers carry no Compose project label: docker prints an empty line for each.
        const byProject = args.some((a) => a.includes('com.docker.compose.project'));
        return { status: 0, stdout: containerIds.map((id) => (byProject ? '' : id)).join('\n') + '\n' };
      }
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
    expect(inv.projects).toBeUndefined();
  });

  it('degrades with a manual-cleanup note when docker is unavailable', () => {
    const inv = scanInstall(deps());
    expect(inv.service.containerIds).toEqual([]);
    expect(inv.service.image).toBeUndefined();
    expect(inv.notes.some((n) => n.includes("'docker' unavailable"))).toBe(true);
  });
});

describe('scanInstall compose projects', () => {
  interface Fake {
    /** container name → [compose project, install slug] */
    containers: Record<string, [string, string]>;
    volumes: Record<string, string>;
    networks: Record<string, string>;
    fail?: (args: string[]) => boolean;
  }
  const projectOf = (args: string[]) =>
    args.find((a) => a.startsWith(`label=${COMPOSE_PROJECT_LABEL}=`))?.split('=')[2];
  /** Docker holding this copy's project next to a decoy copy's, answered by label filters only. */
  const fakeDocker = (fake: Fake) =>
    fakeRun({
      docker: (args) => {
        if (fake.fail?.(args)) return { status: 1, stdout: '' };
        const project = projectOf(args);
        const slug = args.find((a) => a.startsWith('label=nanoclaw-install='))?.split('=')[2];
        if (args[0] === 'ps') {
          const rows = Object.entries(fake.containers).filter(
            ([, [proj, owner]]) => (project ? proj === project : true) && (slug ? owner === slug : true),
          );
          const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : '{{.ID}}';
          const render = ([name, [proj]]: [string, [string, string]]) =>
            format.includes(COMPOSE_PROJECT_LABEL) ? proj : `id-${name}|${name}`;
          // Like docker: one line per row (empty for a missing label), nothing at all for no rows.
          return { status: 0, stdout: rows.length ? rows.map(render).join('\n') + '\n' : '' };
        }
        if (args[0] === 'volume' || args[0] === 'network') {
          const table = args[0] === 'volume' ? fake.volumes : fake.networks;
          const names = Object.entries(table)
            .filter(([, proj]) => proj === project)
            .map(([name]) => name);
          return { status: 0, stdout: names.join('\n') + '\n' };
        }
        return { status: 1, stdout: '' };
      },
    });
  const state = (): Fake => {
    const slug = getInstallSlug(root);
    return {
      containers: {
        [`gw-${slug}-web-1`]: [`gw-${slug}`, slug],
        [`gw-${slug}-database-1`]: [`gw-${slug}`, slug],
        agent1: ['', slug],
        'gw-ffffffff-web-1': ['gw-ffffffff', 'ffffffff'],
      },
      volumes: { [`gw-${slug}_database`]: `gw-${slug}`, 'gw-ffffffff_database': 'gw-ffffffff', stray: 'other' },
      networks: { [`gw-${slug}`]: `gw-${slug}`, 'gw-ffffffff': 'gw-ffffffff', bridge: '' },
    };
  };

  it("lists this copy's project containers, volumes and networks, not a decoy copy's", () => {
    const slug = getInstallSlug(root);
    const inv = scanInstall(deps({ runCommand: fakeDocker(state()) }));
    expect(inv.projects).toEqual({
      names: [`gw-${slug}`],
      containers: [`gw-${slug}-web-1`, `gw-${slug}-database-1`],
      volumes: [`gw-${slug}_database`],
      networks: [`gw-${slug}`],
    });
    expect(inv.notes).toEqual([]);
  });

  it("reports nothing when only the decoy copy's project exists", () => {
    const fake = state();
    const slug = getInstallSlug(root);
    for (const name of [`gw-${slug}-web-1`, `gw-${slug}-database-1`]) delete fake.containers[name];
    expect(scanInstall(deps({ runCommand: fakeDocker(fake) })).projects).toBeUndefined();
  });

  it('never reads a failed volume listing as "no volumes" and gives the exact commands', () => {
    const slug = getInstallSlug(root);
    const fake = state();
    fake.fail = (args) => args[0] === 'volume';
    const inv = scanInstall(deps({ runCommand: fakeDocker(fake) }));
    expect(inv.projects).toBeUndefined();
    expect(inv.notes).toEqual([
      expect.stringContaining(
        `docker ps -aq --filter label=${COMPOSE_PROJECT_LABEL}=gw-${slug} | xargs -r docker rm -f; ` +
          `docker volume ls -q --filter label=${COMPOSE_PROJECT_LABEL}=gw-${slug} | xargs -r docker volume rm; ` +
          `docker network ls -q --filter label=${COMPOSE_PROJECT_LABEL}=gw-${slug} | xargs -r docker network rm`,
      ),
    ]);
  });

  it('notes how to find and remove the projects when docker is unavailable', () => {
    const inv = scanInstall(deps());
    expect(inv.projects).toBeUndefined();
    expect(inv.notes.some((n) => n.startsWith('Service volumes/networks:') && n.includes('<project>'))).toBe(true);
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
