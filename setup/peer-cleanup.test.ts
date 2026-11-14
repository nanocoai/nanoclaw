import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getLaunchdLabel, getSystemdUnit } from '../src/install-slug.js';
import { cleanupUnhealthyPeers } from './peer-cleanup.js';

// The reaper deletes config files from ~/Library/LaunchAgents (or the systemd
// user dir). We point HOME at a throwaway temp dir so real registrations are
// never touched, and force os.platform() so the launchd/systemd branch runs
// regardless of the host running the suite. The best-effort unload inside the
// reaper (launchctl/systemctl) is swallowed when the binary is absent, so these
// tests are deterministic on both macOS and Linux CI.
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  // Never reach the real launchctl/systemctl: launchd fails like a job that is
  // not loaded (print exits 113), and systemctl succeeds.
  execFileSync: vi.fn((command: string) => {
    if (command === 'systemctl') return '';
    throw Object.assign(new Error('not loaded'), { status: 113 });
  }),
}));

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'peer-cleanup-'));
}

function writePlist(filePath: string, target: string): void {
  fs.writeFileSync(
    filePath,
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/node</string><string>${target}</string></array>
</dict></plist>`,
  );
}

function writeUnit(filePath: string, target: string): void {
  fs.writeFileSync(filePath, `[Service]\nExecStart=/usr/bin/node ${target}\n`);
}

const created: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  // Back to the throwing execFileSync for the next test.
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('cleanupUnhealthyPeers — dead launchd registrations', () => {
  function setup(): { home: string; agentsDir: string; projectRoot: string } {
    const home = tempHome();
    created.push(home);
    const agentsDir = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(agentsDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    return { home, agentsDir, projectRoot: path.join(home, 'install') };
  }

  it('removes a plist whose target binary is gone', () => {
    const { agentsDir, projectRoot } = setup();
    const dead = path.join(agentsDir, 'com.nanoclaw-v2-dead.plist');
    writePlist(dead, path.join(agentsDir, 'gone', 'dist', 'index.js'));

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(fs.existsSync(dead)).toBe(false);
    expect(result.removed.map((r) => r.label)).toContain('com.nanoclaw-v2-dead');
  });

  it('removes a dead plist even when launchd still lists it', () => {
    const { agentsDir, projectRoot } = setup();
    const dead = path.join(agentsDir, 'com.nanoclaw-v2-dead.plist');
    writePlist(dead, path.join(agentsDir, 'gone', 'dist', 'index.js'));
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      if (args?.[0] === 'print') return 'state = waiting\n';
      throw new Error('unload failed');
    });

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(fs.existsSync(dead)).toBe(false);
    expect(result.removed.map((r) => r.label)).toEqual(['com.nanoclaw-v2-dead']);
  });

  it('leaves a plist whose target still exists', () => {
    const { agentsDir, projectRoot } = setup();
    const liveTarget = path.join(agentsDir, 'live', 'dist', 'index.js');
    fs.mkdirSync(path.dirname(liveTarget), { recursive: true });
    fs.writeFileSync(liveTarget, '// host entry');
    const live = path.join(agentsDir, 'com.nanoclaw-v2-live.plist');
    writePlist(live, liveTarget);

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(fs.existsSync(live)).toBe(true);
    expect(result.removed).toHaveLength(0);
  });

  it("never reaps this install's own plist, even with a missing target", () => {
    const { agentsDir, projectRoot } = setup();
    const ownLabel = getLaunchdLabel(projectRoot);
    const own = path.join(agentsDir, `${ownLabel}.plist`);
    writePlist(own, path.join(agentsDir, 'gone', 'dist', 'index.js'));

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(fs.existsSync(own)).toBe(true);
    expect(result.removed).toHaveLength(0);
  });

  it('ignores an unrecognized plist (no dist/index.js target)', () => {
    const { agentsDir, projectRoot } = setup();
    const weird = path.join(agentsDir, 'com.nanoclaw-v2-weird.plist');
    fs.writeFileSync(weird, '<plist><dict></dict></plist>');

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(fs.existsSync(weird)).toBe(true);
    expect(result.removed).toHaveLength(0);
  });
});

describe('cleanupUnhealthyPeers — dead systemd registrations', () => {
  function setup(): { unitDir: string; projectRoot: string } {
    const home = tempHome();
    created.push(home);
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    return { unitDir, projectRoot: path.join(home, 'install') };
  }

  it('removes a unit whose target binary is gone', () => {
    const { unitDir, projectRoot } = setup();
    const dead = path.join(unitDir, 'nanoclaw-v2-dead.service');
    writeUnit(dead, path.join(unitDir, 'gone', 'dist', 'index.js'));

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(fs.existsSync(dead)).toBe(false);
    expect(result.removed.map((r) => r.label)).toContain('nanoclaw-v2-dead');
  });

  it("never reaps this install's own unit", () => {
    const { unitDir, projectRoot } = setup();
    const ownUnit = getSystemdUnit(projectRoot);
    const own = path.join(unitDir, `${ownUnit}.service`);
    writeUnit(own, path.join(unitDir, 'gone', 'dist', 'index.js'));

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(fs.existsSync(own)).toBe(true);
    expect(result.removed).toHaveLength(0);
  });
});

// A changed NANOCLAW_INSTALL_ID gives this checkout a new service name. The old
// registration would start a second host on the same checkout, so it goes.
describe('cleanupUnhealthyPeers — another name for this checkout', () => {
  function checkout(platform: 'darwin' | 'linux'): { home: string; projectRoot: string; entry: string } {
    const home = tempHome();
    created.push(home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(os, 'platform').mockReturnValue(platform);
    const projectRoot = path.join(home, 'install');
    const entry = path.join(projectRoot, 'dist', 'index.js');
    // A live target, so the dead-registration path does not apply.
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '// host entry');
    return { home, projectRoot, entry };
  }

  const directions: Array<[string, string | undefined, string | undefined]> = [
    ['hash to id', undefined, 'prod-eks_1'],
    ['id to hash', 'prod-eks_1', undefined],
    ['id to id', 'prod-eks_1', 'staging'],
  ];

  it.each(directions)('retires the launchd plist from before, %s', (_name, before, after) => {
    const { home, projectRoot, entry } = checkout('darwin');
    const agentsDir = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(agentsDir, { recursive: true });
    vi.stubEnv('NANOCLAW_INSTALL_ID', before);
    const label = getLaunchdLabel(projectRoot);
    const old = path.join(agentsDir, `${label}.plist`);
    writePlist(old, entry);
    vi.stubEnv('NANOCLAW_INSTALL_ID', after);
    const own = path.join(agentsDir, `${getLaunchdLabel(projectRoot)}.plist`);
    writePlist(own, entry);

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(execFileSync).toHaveBeenCalledWith('launchctl', ['unload', old], { stdio: 'pipe' });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(own)).toBe(true);
    expect(result.retired).toEqual([{ label, configPath: old }]);
  });

  it.each(directions)('retires the systemd unit from before, %s', (_name, before, after) => {
    const { home, projectRoot, entry } = checkout('linux');
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    vi.stubEnv('NANOCLAW_INSTALL_ID', before);
    const unit = getSystemdUnit(projectRoot);
    const old = path.join(unitDir, `${unit}.service`);
    writeUnit(old, entry);
    vi.stubEnv('NANOCLAW_INSTALL_ID', after);
    const own = path.join(unitDir, `${getSystemdUnit(projectRoot)}.service`);
    writeUnit(own, entry);

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(execFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'disable', '--now', `${unit}.service`], {
      stdio: 'pipe',
    });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(own)).toBe(true);
    expect(result.retired).toEqual([{ label: unit, configPath: old }]);
  });

  // Deleting the file of a service that is still running would leave no way to stop it by path.
  it('keeps the launchd plist when the old service does not stop', () => {
    const { home, projectRoot, entry } = checkout('darwin');
    const old = path.join(home, 'Library', 'LaunchAgents', 'com.nanoclaw-v2-old.plist');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    writePlist(old, entry);
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      if (args?.[0] === 'print') return 'state = running\n';
      throw new Error('unload failed');
    });

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(fs.existsSync(old)).toBe(true);
    expect(result.retired).toEqual([]);
    expect(result.failures.map((f) => f.label)).toEqual(['com.nanoclaw-v2-old']);
  });

  // is-active also says inactive (3) while a unit waits to auto-restart, so only disable --now counts.
  it('keeps the systemd unit when disable --now fails', () => {
    const { home, projectRoot, entry } = checkout('linux');
    const old = path.join(home, '.config', 'systemd', 'user', 'nanoclaw-v2-old.service');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    writeUnit(old, entry);
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      if (args?.[1] === 'is-active') throw Object.assign(new Error('inactive'), { status: 3 });
      throw Object.assign(new Error('Failed to disable unit: Read-only file system'), { status: 1 });
    });

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(fs.existsSync(old)).toBe(true);
    expect(result.retired).toEqual([]);
    expect(result.failures.map((f) => f.label)).toEqual(['nanoclaw-v2-old']);
  });

  it('keeps the launchd plist when launchd cannot say whether it stopped', () => {
    const { home, projectRoot, entry } = checkout('darwin');
    const old = path.join(home, 'Library', 'LaunchAgents', 'com.nanoclaw-v2-old.plist');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    writePlist(old, entry);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error('Operation not permitted'), { status: 1 });
    });

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(fs.existsSync(old)).toBe(true);
    expect(result.failures.map((f) => f.label)).toEqual(['com.nanoclaw-v2-old']);
  });

  it('keeps the systemd unit when the user bus cannot be reached', () => {
    const { home, projectRoot, entry } = checkout('linux');
    const old = path.join(home, '.config', 'systemd', 'user', 'nanoclaw-v2-old.service');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    writeUnit(old, entry);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error('Failed to connect to bus'), { status: 1 });
    });

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(fs.existsSync(old)).toBe(true);
    expect(result.failures.map((f) => f.label)).toEqual(['nanoclaw-v2-old']);
  });

  it('retires the systemd unit when systemctl is not installed', () => {
    const { home, projectRoot, entry } = checkout('linux');
    const old = path.join(home, '.config', 'systemd', 'user', 'nanoclaw-v2-old.service');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    writeUnit(old, entry);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error('spawnSync systemctl ENOENT'), { code: 'ENOENT' });
    });

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(fs.existsSync(old)).toBe(false);
    expect(result.retired.map((r) => r.label)).toEqual(['nanoclaw-v2-old']);
  });

  // The other checkout's path ends with this one's, so only an exact match is safe.
  const otherEntry = (home: string, projectRoot: string): string => {
    const entry = path.join(home, 'nested', projectRoot, 'dist', 'index.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '// host entry');
    return entry;
  };

  it('leaves a launchd service for another checkout alone', () => {
    const { home, projectRoot } = checkout('darwin');
    const other = path.join(home, 'Library', 'LaunchAgents', 'com.nanoclaw-v2-other.plist');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    writePlist(other, otherEntry(home, projectRoot));

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(execFileSync).not.toHaveBeenCalledWith('launchctl', ['unload', other], expect.anything());
    expect(fs.existsSync(other)).toBe(true);
    expect(result.retired).toEqual([]);
  });

  it('leaves a systemd service for another checkout alone', () => {
    const { home, projectRoot } = checkout('linux');
    const other = path.join(home, '.config', 'systemd', 'user', 'nanoclaw-v2-other.service');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    writeUnit(other, otherEntry(home, projectRoot));

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(execFileSync).not.toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'disable', '--now', 'nanoclaw-v2-other.service'],
      expect.anything(),
    );
    expect(fs.existsSync(other)).toBe(true);
    expect(result.retired).toEqual([]);
  });
});
