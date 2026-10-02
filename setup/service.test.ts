import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { getLaunchdLabel } from '../src/install-slug.js';
import { hostProxyEnv, nodeHonorsEnvProxy, renderSystemdUnit } from './service.js';

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
      NO_PROXY: 'localhost,127.0.0.1,::1,[::1]',
    });
  });

  it('resolves HTTPS_PROXY and HTTP_PROXY separately, falling back to ALL_PROXY, then the other key', () => {
    const both = hostProxyEnv(root, { HTTPS_PROXY: 'http://s.example:1', HTTP_PROXY: 'http://h.example:2' });
    expect(both).toMatchObject({ HTTPS_PROXY: 'http://s.example:1', HTTP_PROXY: 'http://h.example:2' });
    const all = hostProxyEnv(root, { HTTPS_PROXY: 'http://s.example:1', ALL_PROXY: 'http://all.example:3' });
    expect(all).toMatchObject({ HTTPS_PROXY: 'http://s.example:1', HTTP_PROXY: 'http://all.example:3' });
    expect(hostProxyEnv(root, { HTTP_PROXY: 'http://h.example:2' })).toMatchObject({
      HTTPS_PROXY: 'http://h.example:2',
      HTTP_PROXY: 'http://h.example:2',
    });
    expect(hostProxyEnv(root, { https_proxy: 'http://lower.example:4' }).HTTPS_PROXY).toBe('http://lower.example:4');
  });

  it('resolves each key shell-over-file', () => {
    fs.writeFileSync(path.join(root, '.env'), 'HTTPS_PROXY=http://file.example:1\n');
    expect(hostProxyEnv(root, { HTTP_PROXY: 'http://shell.example:2' })).toMatchObject({
      HTTPS_PROXY: 'http://file.example:1',
      HTTP_PROXY: 'http://shell.example:2',
    });
  });

  it('adds a user NO_PROXY to the defaults instead of replacing them', () => {
    const env = { HTTPS_PROXY: 'http://proxy.example:3128', NO_PROXY: ' .example.net, localhost ' };
    expect(hostProxyEnv(root, env).NO_PROXY).toBe('localhost,127.0.0.1,::1,[::1],.example.net');
  });

  it('merges uppercase and lowercase environment NO_PROXY with the .env list', () => {
    fs.writeFileSync(path.join(root, '.env'), `NO_PROXY=host.docker.internal,api.example\n`);
    const env = {
      HTTPS_PROXY: 'http://proxy.example:3128',
      NO_PROXY: '.example.net',
      no_proxy: '.lower.example',
    };
    expect(hostProxyEnv(root, env).NO_PROXY).toBe(
      `localhost,127.0.0.1,::1,[::1],.example.net,.lower.example,host.docker.internal,api.example`,
    );
  });

  it('reads .env when the environment has no proxy, and the environment wins over .env', () => {
    fs.writeFileSync(
      path.join(root, '.env'),
      'HTTPS_PROXY=http://file.example:8080\nNO_PROXY=localhost,.example.org\n',
    );
    expect(hostProxyEnv(root, {})).toMatchObject({
      HTTPS_PROXY: 'http://file.example:8080',
      NO_PROXY: 'localhost,127.0.0.1,::1,[::1],.example.org',
    });
    expect(hostProxyEnv(root, { HTTPS_PROXY: 'http://shell.example:1' }).HTTPS_PROXY).toBe('http://shell.example:1');
  });

  it('skips proxies Node cannot use', () => {
    expect(hostProxyEnv(root, { ALL_PROXY: 'socks5://127.0.0.1:1080' })).toEqual({});
  });
});

describe('nodeHonorsEnvProxy', () => {
  it('accepts 22.21+, 24.5+ and 25+ only', () => {
    for (const v of ['22.21.0', '22.22.1', '24.5.0', '25.0.0']) expect(nodeHonorsEnvProxy(v)).toBe(true);
    for (const v of ['20.19.0', '22.20.0', '23.11.1', '24.0.0', '24.4.1']) expect(nodeHonorsEnvProxy(v)).toBe(false);
  });
});

describe('renderSystemdUnit', () => {
  let root: string;
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-unit-'));
    saved = { ...process.env };
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
      delete process.env[key];
      delete process.env[key.toLowerCase()];
    }
  });

  afterEach(() => {
    process.env = saved;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes quoted proxy Environment= lines when a proxy is configured', () => {
    fs.writeFileSync(path.join(root, '.env'), 'HTTPS_PROXY=http://proxy.example:3128\nNO_PROXY=a, b\n');
    const unit = renderSystemdUnit(root, '/usr/bin/node', '/home/user', false);
    expect(unit).toContain('Environment="NODE_USE_ENV_PROXY=1"');
    expect(unit).toContain('Environment="HTTPS_PROXY=http://proxy.example:3128"');
    expect(unit).toContain('Environment="HTTP_PROXY=http://proxy.example:3128"');
    expect(unit).toContain('Environment="NO_PROXY=localhost,127.0.0.1,::1,[::1],a,b"');
    expect(unit).toContain('Environment="https_proxy=http://proxy.example:3128"');
    expect(unit).toContain('Environment="http_proxy=http://proxy.example:3128"');
    expect(unit).toContain('Environment="no_proxy=localhost,127.0.0.1,::1,[::1],a,b"');
    expect(unit).not.toContain('node_use_env_proxy');
  });

  it('writes no proxy lines without a proxy', () => {
    expect(renderSystemdUnit(root, '/usr/bin/node', '/home/user', false)).not.toContain('PROXY');
  });
});
