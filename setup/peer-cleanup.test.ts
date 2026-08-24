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
