import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

import { log } from '../src/log.js';
import { getLaunchdLabel } from '../src/install-slug.js';
import { manageUserLinger } from './linger.js';
import type { EncryptedHomeDetection } from './linger.js';

/**
 * Tests for service configuration generation.
 *
 * These tests verify the generated content of plist/systemd/nohup configs
 * without actually loading services.
 */

// Helper: generate a plist string the same way service.ts does
function generatePlist(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
): string {
  const label = getLaunchdLabel(projectRoot);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${projectRoot}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/nanoclaw.error.log</string>
</dict>
</plist>`;
}

function generateSystemdUnit(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
  isSystem: boolean,
): string {
  return `[Unit]
Description=NanoClaw Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${projectRoot}/dist/index.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=${homeDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
StandardOutput=append:${projectRoot}/logs/nanoclaw.log
StandardError=append:${projectRoot}/logs/nanoclaw.error.log

[Install]
WantedBy=${isSystem ? 'multi-user.target' : 'default.target'}`;
}

describe('plist generation', () => {
  it('contains the slug-scoped label', () => {
    const projectRoot = '/home/user/nanoclaw';
    const plist = generatePlist('/usr/local/bin/node', projectRoot, '/home/user');
    expect(plist).toContain(`<string>${getLaunchdLabel(projectRoot)}</string>`);
    expect(plist).toMatch(/<string>com\.nanoclaw-v2-[0-9a-f]{8}<\/string>/);
  });

  it('uses the correct node path', () => {
    const plist = generatePlist(
      '/opt/node/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
    );
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
  });

  it('points to dist/index.js', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
    );
    expect(plist).toContain('/home/user/nanoclaw/dist/index.js');
  });

  it('sets log paths', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
    );
    expect(plist).toContain('nanoclaw.log');
    expect(plist).toContain('nanoclaw.error.log');
  });
});

describe('systemd unit generation', () => {
  it('user unit uses default.target', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('WantedBy=default.target');
  });

  it('system unit uses multi-user.target', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      true,
    );
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('contains restart policy', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
  });

  it('uses KillMode=process to preserve detached children', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('KillMode=process');
  });

  it('sets correct ExecStart', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/srv/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain(
      'ExecStart=/usr/bin/node /srv/nanoclaw/dist/index.js',
    );
  });
});

describe('manageUserLinger (encrypted-home guard, issue #2680)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  // Realistic per-install unit name (matches getSystemdUnit(projectRoot)
  // format `nanoclaw-v2-<8-hex-slug>`). The warning must interpolate this
  // rather than the static word "nanoclaw" — copy-pasting the recovery
  // command with the wrong unit name leaves users stuck on
  // `Unit nanoclaw.service not found.` See issue #2680.
  const testUnitName = 'nanoclaw-v2-abc123';

  it('skips loginctl enable-linger when an encrypted home is detected', () => {
    const detected: EncryptedHomeDetection = {
      detected: true,
      type: 'ecryptfs',
      signal: 'findmnt reports FSTYPE=ecryptfs for /home/user',
    };
    const exec = vi.fn();

    const result = manageUserLinger(testUnitName, () => detected, exec);

    expect(exec).not.toHaveBeenCalled();
    expect(result.lingerEnabled).toBe(false);
    expect(result.encryptedHome).toEqual(detected);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [warnMessage, warnData] = warnSpy.mock.calls[0];
    expect(warnMessage).toContain('Per-home encryption detected (ecryptfs)');
    expect(warnMessage).toContain('skipping');
    expect(warnMessage).toContain('loginctl enable-linger');
    expect(warnMessage).toContain('systemctl --user daemon-reload');
    expect(warnMessage).toContain(
      `systemctl --user start ${testUnitName}`,
    );
    // Regression guard: must NOT recommend the static `nanoclaw` unit name.
    expect(warnMessage).not.toContain('systemctl --user start nanoclaw ');
    expect(warnMessage).not.toMatch(/systemctl --user start nanoclaw\.$/);
    expect(warnMessage).toContain('issues/2680');
    expect(warnData).toMatchObject({
      type: 'ecryptfs',
      unitName: testUnitName,
    });
  });

  it('also skips for fscrypt and gocryptfs detections', () => {
    for (const type of ['fscrypt', 'gocryptfs'] as const) {
      const exec = vi.fn();
      const result = manageUserLinger(
        testUnitName,
        () => ({ detected: true, type, signal: `probe:${type}` }),
        exec,
      );
      expect(exec).not.toHaveBeenCalled();
      expect(result.lingerEnabled).toBe(false);
      expect(result.encryptedHome?.type).toBe(type);
    }
  });

  it('runs loginctl enable-linger when no encrypted home is detected', () => {
    const exec = vi.fn();

    const result = manageUserLinger(
      testUnitName,
      () => ({ detected: false }),
      exec,
    );

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('loginctl enable-linger');
    expect(result.lingerEnabled).toBe(true);
    expect(result.encryptedHome).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('reports lingerEnabled=false and warns when loginctl fails', () => {
    const exec = vi.fn(() => {
      throw new Error('loginctl not available');
    });

    const result = manageUserLinger(
      testUnitName,
      () => ({ detected: false }),
      exec,
    );

    expect(result.lingerEnabled).toBe(false);
    expect(result.encryptedHome).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('loginctl enable-linger failed');
  });
});

describe('WSL nohup fallback', () => {
  it('generates a valid wrapper script', () => {
    const projectRoot = '/home/user/nanoclaw';
    const nodePath = '/usr/bin/node';
    const pidFile = path.join(projectRoot, 'nanoclaw.pid');

    // Simulate what service.ts generates
    const wrapper = `#!/bin/bash
set -euo pipefail
cd ${JSON.stringify(projectRoot)}
nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot)}/dist/index.js >> ${JSON.stringify(projectRoot)}/logs/nanoclaw.log 2>> ${JSON.stringify(projectRoot)}/logs/nanoclaw.error.log &
echo $! > ${JSON.stringify(pidFile)}`;

    expect(wrapper).toContain('#!/bin/bash');
    expect(wrapper).toContain('nohup');
    expect(wrapper).toContain(nodePath);
    expect(wrapper).toContain('nanoclaw.pid');
  });
});
