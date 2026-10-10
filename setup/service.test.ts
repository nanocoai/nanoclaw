import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import { getLaunchdLabel, getSystemdUnit } from '../src/install-slug.js';
import { log } from '../src/log.js';
import {
  hostProxyEnv,
  nodeHonorsEnvProxy,
  renderSystemdUnit,
  serviceProxyEnvPath,
  tightenCredentialFiles,
  writeOwnerOnly,
  writeServiceProxyEnv,
} from './service.js';

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

describe('service proxy environment', () => {
  let root: string;
  let saved: NodeJS.ProcessEnv;
  let savedUmask: number;
  const authed = 'http://user:SYNTHETIC_PROXY_PASSWORD@proxy.example:3128';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-unit-'));
    saved = { ...process.env };
    savedUmask = process.umask(0o022);
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
      delete process.env[key];
      delete process.env[key.toLowerCase()];
    }
  });

  afterEach(() => {
    process.env = saved;
    process.umask(savedUmask);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const mode = (file: string) => fs.statSync(file).mode & 0o777;

  it.each([false, true])('keeps proxy credentials out of the unit (system unit: %s)', (asRoot) => {
    fs.writeFileSync(path.join(root, '.env'), `HTTPS_PROXY=${authed}\n`);
    const envFile = writeServiceProxyEnv(root);
    expect(envFile).toBe(serviceProxyEnvPath(root));
    const unit = renderSystemdUnit(root, '/usr/bin/node', '/home/user', asRoot, envFile);
    expect(unit).not.toContain('SYNTHETIC_PROXY_PASSWORD');
    expect(unit).not.toContain('PROXY');
    expect(unit).toContain(`EnvironmentFile=${envFile}`);
    expect(mode(envFile!)).toBe(0o600);
  });

  it('writes every proxy key and its lowercase twin, readable by a shell', () => {
    fs.writeFileSync(path.join(root, '.env'), `HTTPS_PROXY=${authed}\nNO_PROXY=a, b\n`);
    const envFile = writeServiceProxyEnv(root)!;
    const content = fs.readFileSync(envFile, 'utf8');
    expect(content).toContain('NODE_USE_ENV_PROXY="1"');
    expect(content).toContain('no_proxy="localhost,127.0.0.1,::1,[::1],a,b"');
    expect(content).not.toContain('node_use_env_proxy');
    const sourced = execFileSync(
      '/bin/bash',
      ['-c', 'set -a; . "$1"; printf "%s\\n" "$HTTPS_PROXY" "$http_proxy" "$NO_PROXY" "$no_proxy"', '_', envFile],
      { encoding: 'utf8', env: { PATH: process.env.PATH } },
    );
    const noProxy = 'localhost,127.0.0.1,::1,[::1],a,b';
    expect(sourced.trim().split('\n')).toEqual([authed, authed, noProxy, noProxy]);
  });

  it('escapes characters that are special inside double quotes', () => {
    const odd = 'http://u:p$a"s`s\\w%d@proxy.example:1';
    process.env.HTTPS_PROXY = odd;
    const envFile = writeServiceProxyEnv(root)!;
    const sourced = execFileSync('/bin/bash', ['-c', '. "$1"; printf "%s" "$HTTPS_PROXY"', '_', envFile], {
      encoding: 'utf8',
    });
    expect(sourced).toBe(odd);
  });

  it('tightens an existing broader-mode file on rerun', () => {
    const envFile = serviceProxyEnvPath(root);
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, 'stale\n', { mode: 0o644 });
    process.env.HTTPS_PROXY = authed;
    writeServiceProxyEnv(root);
    expect(mode(envFile)).toBe(0o600);
    expect(fs.readFileSync(envFile, 'utf8')).toContain('SYNTHETIC_PROXY_PASSWORD');
  });

  it('removes a stale file and writes no unit line when no proxy is configured', () => {
    const envFile = serviceProxyEnvPath(root);
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, 'HTTPS_PROXY="http://old.example:1"\n');
    expect(writeServiceProxyEnv(root)).toBeUndefined();
    expect(fs.existsSync(envFile)).toBe(false);
    expect(renderSystemdUnit(root, '/usr/bin/node', '/home/user', false)).not.toContain('Environment' + 'File');
  });

  it('escapes glob characters in the EnvironmentFile= path', () => {
    const unit = renderSystemdUnit(root, '/usr/bin/node', '/root', true, '/opt/nc[dev]/data/service-proxy.env');
    expect(unit).toContain('EnvironmentFile=/opt/nc\\[dev\\]/data/service-proxy.env');
  });

  it('accepts space-separated NO_PROXY entries', () => {
    const env = { HTTPS_PROXY: 'http://proxy.example:1', no_proxy: 'api.internal gateway.internal\n.x' };
    expect(hostProxyEnv(root, env).NO_PROXY).toBe('localhost,127.0.0.1,::1,[::1],api.internal,gateway.internal,.x');
  });

  it('ignores proxy URLs containing whitespace', () => {
    expect(hostProxyEnv(root, { HTTPS_PROXY: 'http://proxy.example:1\nX=1' })).toEqual({});
  });
});

describe('writeOwnerOnly', () => {
  let dir: string;
  let savedUmask: number;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-owner-'));
    savedUmask = process.umask(0o022);
  });
  afterEach(() => {
    process.umask(savedUmask);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates new files and replaces existing ones as 0600', () => {
    const fresh = path.join(dir, 'fresh.plist');
    writeOwnerOnly(fresh, 'a');
    expect(fs.statSync(fresh).mode & 0o777).toBe(0o600);
    const existing = path.join(dir, 'existing.plist');
    fs.writeFileSync(existing, 'old', { mode: 0o644 });
    writeOwnerOnly(existing, 'new');
    expect(fs.statSync(existing).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(existing, 'utf8')).toBe('new');
    expect(fs.readdirSync(dir).sort()).toEqual(['existing.plist', 'fresh.plist']);
  });
});

describe('tightenCredentialFiles', () => {
  let root: string;
  let unitFile: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tighten-'));
    const unitDir = path.join(root, 'home/.config/systemd/user');
    fs.mkdirSync(unitDir, { recursive: true });
    unitFile = path.join(unitDir, `${getSystemdUnit(root)}.service`);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    [
      'launchd plist',
      () => path.join(root, 'home/Library/LaunchAgents', `${getLaunchdLabel(root)}.plist`),
      0o644,
      0o600,
    ],
    ['user unit', () => unitFile, 0o644, 0o600],
    ['nohup wrapper', () => path.join(root, 'start-nanoclaw.sh'), 0o755, 0o700],
  ])('restricts a %s holding a proxy credential, keeping owner bits', (_name, file, before, after) => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), 'export HTTPS_PROXY=http://u:p@proxy.example:1\n');
    fs.chmodSync(file(), before);
    tightenCredentialFiles(root, path.join(root, 'home'));
    expect(fs.statSync(file()).mode & 0o777).toBe(after);
  });

  it('does not read or change a file that is already owner-only', () => {
    fs.writeFileSync(unitFile, 'Environment="HTTPS_PROXY=http://u:p@proxy.example:1"\n');
    fs.chmodSync(unitFile, 0o600);
    const read = vi.spyOn(fs, 'readFileSync');
    tightenCredentialFiles(root, path.join(root, 'home'));
    expect(read).not.toHaveBeenCalledWith(unitFile, 'utf8');
    expect(fs.statSync(unitFile).mode & 0o777).toBe(0o600);
  });

  it('leaves a service file without proxy credentials untouched', () => {
    fs.writeFileSync(unitFile, 'Environment="HTTPS_PROXY=http://proxy.example:1"\n', { mode: 0o644 });
    fs.chmodSync(unitFile, 0o644);
    tightenCredentialFiles(root, path.join(root, 'home'));
    expect(fs.statSync(unitFile).mode & 0o777).toBe(0o644);
  });

  it('names the file and the fix when it cannot change the mode', () => {
    fs.writeFileSync(unitFile, 'Environment="HTTPS_PROXY=http://u:p@proxy.example:1"\n', { mode: 0o644 });
    fs.chmodSync(unitFile, 0o644);
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    tightenCredentialFiles(root, path.join(root, 'home'));
    const fix = `sudo chmod 600 '${unitFile}'`;
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(fix), expect.objectContaining({ file: unitFile, fix }));
  });
});
