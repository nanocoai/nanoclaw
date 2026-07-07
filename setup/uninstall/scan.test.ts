import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { getLaunchdLabel, getSystemdUnit } from '../../src/install-slug.js';
import type { RunCommand } from './onecli-agents.js';
import { detectExistingInstall, scanInstall, type ScanDeps } from './scan.js';

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
function fakeRun(
  handlers: Record<string, (args: string[]) => { status: number | null; stdout: string }>,
): RunCommand {
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
      if (args[0] === 'ps') return { status: 0, stdout: containerIds.join('\n') + '\n' };
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

    const inv = scanInstall(deps());

    expect(inv.data.map((i) => path.basename(i.path))).toEqual([
      'data',
      'logs',
      '.env',
      'start-nanoclaw.sh',
    ]);
    expect(inv.runtime.map((i) => path.basename(i.path))).toEqual([
      'dist',
      'node_modules',
    ]);
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
    const plist = path.join(
      home,
      'Library',
      'LaunchAgents',
      `${getLaunchdLabel(root)}.plist`,
    );
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, '<plist/>');

    const inv = scanInstall(deps());
    expect(inv.service.launchdPlist).toBe(plist);
    expect(inv.service.systemdUserUnit).toBeUndefined();
  });

  it('detects systemd user unit and pidfile on Linux', () => {
    const unit = path.join(
      home,
      '.config',
      'systemd',
      'user',
      `${getSystemdUnit(root)}.service`,
    );
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
  });

  it('degrades with a manual-cleanup note when docker is unavailable', () => {
    const inv = scanInstall(deps());
    expect(inv.service.containerIds).toEqual([]);
    expect(inv.service.image).toBeUndefined();
    expect(inv.notes.some((n) => n.includes("'docker' unavailable"))).toBe(true);
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

describe('scanInstall OneCLI agents', () => {
  const vault = JSON.stringify({
    data: [
      { id: 'u-1', identifier: 'ag-mine', name: 'Mine', isDefault: false },
      { id: 'u-2', identifier: 'ag-other', name: 'Other', isDefault: false },
    ],
  });
  const onecliUp = fakeRun({ onecli: () => ({ status: 0, stdout: vault }) });

  it('splits mine vs orphans against the central DB', () => {
    fs.mkdirSync(path.join(root, 'data'));
    const db = new Database(path.join(root, 'data', 'v2.db'));
    db.exec('CREATE TABLE agent_groups (id TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO agent_groups (id) VALUES (?)').run('ag-mine');
    db.close();

    const inv = scanInstall(deps({ runCommand: onecliUp }));
    expect(inv.onecli.idsKnown).toBe(true);
    expect(inv.onecli.mine.map((a) => a.identifier)).toEqual(['ag-mine']);
    expect(inv.onecli.orphans.map((a) => a.identifier)).toEqual(['ag-other']);
  });

  it('flags orphan labels as unreliable when the DB is unreadable', () => {
    const inv = scanInstall(deps({ runCommand: onecliUp }));
    expect(inv.onecli.idsKnown).toBe(false);
    expect(inv.onecli.mine).toEqual([]);
    expect(inv.onecli.orphans.map((a) => a.identifier)).toEqual(['ag-mine', 'ag-other']);
    expect(inv.notes.some((n) => n.includes("Couldn't read agent_groups"))).toBe(true);
  });
});

describe('detectExistingInstall', () => {
  it('is false for an empty checkout', () => {
    expect(detectExistingInstall(root)).toBe(false);
  });

  it('is true when the central DB exists', () => {
    fs.mkdirSync(path.join(root, 'data'));
    const db = new Database(path.join(root, 'data', 'v2.db'));
    db.close();
    expect(detectExistingInstall(root)).toBe(true);
  });
});
