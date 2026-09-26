import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { getLaunchdLabel } from '../src/install-slug.js';
import { hostProxyEnv } from './service.js';

/**
 * Tests for service configuration generation.
 *
 * These tests verify the generated content of plist/systemd/nohup configs
 * without actually loading services.
 */

// Helper: generate a plist string the same way service.ts does
function generatePlist(nodePath: string, projectRoot: string, homeDir: string): string {
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

function generateSystemdUnit(nodePath: string, projectRoot: string, homeDir: string, isSystem: boolean): string {
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
    const plist = generatePlist('/opt/node/bin/node', '/home/user/nanoclaw', '/home/user');
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
  });

  it('points to dist/index.js', () => {
    const plist = generatePlist('/usr/local/bin/node', '/home/user/nanoclaw', '/home/user');
    expect(plist).toContain('/home/user/nanoclaw/dist/index.js');
  });

  it('sets log paths', () => {
    const plist = generatePlist('/usr/local/bin/node', '/home/user/nanoclaw', '/home/user');
    expect(plist).toContain('nanoclaw.log');
    expect(plist).toContain('nanoclaw.error.log');
  });
});

describe('systemd unit generation', () => {
  it('user unit uses default.target', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', false);
    expect(unit).toContain('WantedBy=default.target');
  });

  it('system unit uses multi-user.target', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', true);
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('contains restart policy', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', false);
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
  });

  it('uses KillMode=process to preserve detached children', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', false);
    expect(unit).toContain('KillMode=process');
  });

  it('sets correct ExecStart', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/srv/nanoclaw', '/home/user', false);
    expect(unit).toContain('ExecStart=/usr/bin/node /srv/nanoclaw/dist/index.js');
  });
});

describe('hostProxyEnv', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-proxy-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is empty when no proxy is configured', () => {
    expect(hostProxyEnv(root, {})).toEqual({});
  });

  it('enables the env proxy and keeps local addresses direct', () => {
    expect(hostProxyEnv(root, { HTTPS_PROXY: 'http://proxy.example:3128' })).toEqual({
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: 'http://proxy.example:3128',
      HTTP_PROXY: 'http://proxy.example:3128',
      NO_PROXY: 'localhost,127.0.0.1,::1',
    });
  });

  it('prefers HTTPS_PROXY, then HTTP_PROXY, then ALL_PROXY', () => {
    const env = { HTTP_PROXY: 'http://http.example:1', ALL_PROXY: 'http://all.example:2' };
    expect(hostProxyEnv(root, env).HTTPS_PROXY).toBe('http://http.example:1');
    expect(hostProxyEnv(root, { ALL_PROXY: 'http://all.example:2' }).HTTPS_PROXY).toBe('http://all.example:2');
    expect(hostProxyEnv(root, { https_proxy: 'http://lower.example:3', ...env }).HTTPS_PROXY).toBe(
      'http://lower.example:3',
    );
  });

  it('reads .env when the environment has no proxy, and the environment wins over .env', () => {
    fs.writeFileSync(path.join(root, '.env'), 'HTTPS_PROXY=http://file.example:8080\nNO_PROXY=localhost,.internal\n');
    expect(hostProxyEnv(root, {})).toMatchObject({
      HTTPS_PROXY: 'http://file.example:8080',
      NO_PROXY: 'localhost,.internal',
    });
    expect(hostProxyEnv(root, { HTTPS_PROXY: 'http://shell.example:1' }).HTTPS_PROXY).toBe('http://shell.example:1');
  });

  it('skips proxies Node cannot use', () => {
    expect(hostProxyEnv(root, { ALL_PROXY: 'socks5://127.0.0.1:1080' })).toEqual({});
  });
});
