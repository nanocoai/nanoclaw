/**
 * Docker starts the installed credential helper long after setup wrote it, so
 * it has to start whatever became of the node that installed it. These render
 * the real helper source and run the result.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HELPER_BINARY_NAME,
  installCredentialHelper,
  refreshInstalledCredentialHelper,
  renderHelper,
} from './install-cred-helper.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(here, 'registry', 'credential-helper.mjs'), 'utf-8');
const HELPER_ID = 'nanoclaw-docker-credential-helper';
const GONE_NODE = '/nonexistent/node/1.0.0/bin/node';
const HOST = 'reg.example.com';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-helper-'));
  scratch.push(dir);
  return dir;
}

/** A directory to put on PATH: holding the real node, or a `node` that cannot run anything. */
function nodeDir(kind: 'real' | 'broken'): string {
  const dir = scratchDir();
  if (kind === 'real') fs.symlinkSync(process.execPath, path.join(dir, 'node'));
  else fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\nexit 126\n', { mode: 0o755 });
  return dir;
}

function writeHelper(dir: string, contents: string): string {
  const file = path.join(dir, HELPER_BINARY_NAME);
  fs.writeFileSync(file, contents, { mode: 0o755 });
  return file;
}

/** Run `write` so that the helper it writes cannot start: its node gone, and none on PATH. */
function withNoNode(write: () => void): void {
  const { execPath } = process;
  const { PATH } = process.env;
  Object.defineProperty(process, 'execPath', { value: GONE_NODE, configurable: true });
  process.env.PATH = scratchDir();
  try {
    write();
  } finally {
    Object.defineProperty(process, 'execPath', { value: execPath, configurable: true });
    process.env.PATH = PATH;
  }
}

/** Start the helper as docker does: by path, with nothing but this PATH to find a node on. */
function version(helper: string, pathDir: string): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(helper, ['version'], { encoding: 'utf-8', env: { PATH: pathDir } });
}

describe('renderHelper', () => {
  it('starts on the node on PATH once the node it was installed with is gone', () => {
    const helper = writeHelper(scratchDir(), renderHelper(SOURCE, GONE_NODE));

    const res = version(helper, nodeDir('real'));

    expect(res.stdout).toContain(HELPER_ID);
    expect(res.status).toBe(0);
  });

  it('prefers the node it was installed with while that one is there', () => {
    const helper = writeHelper(scratchDir(), renderHelper(SOURCE, process.execPath));

    const res = version(helper, nodeDir('broken'));

    expect(res.stdout).toContain(HELPER_ID);
    expect(res.status).toBe(0);
  });

  it('starts on a node whose path has a space and a quote', () => {
    const odd = path.join(scratchDir(), "it's a dir");
    fs.mkdirSync(odd);
    fs.symlinkSync(process.execPath, path.join(odd, 'node'));
    const helper = writeHelper(scratchDir(), renderHelper(SOURCE, path.join(odd, 'node')));

    const res = version(helper, nodeDir('broken'));

    expect(res.stdout).toContain(HELPER_ID);
    expect(res.status).toBe(0);
  });

  it('says node is missing when neither is there', () => {
    const helper = writeHelper(scratchDir(), renderHelper(SOURCE, GONE_NODE));

    const res = version(helper, scratchDir());

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('node');
  });

  it('falls back to the node on PATH when the node it was installed with cannot run here', () => {
    // Executable, yet nothing this machine can start: what another OS's node
    // looks like in a home directory two systems share.
    const foreign = path.join(scratchDir(), 'node');
    fs.writeFileSync(foreign, '#!/nonexistent/interpreter\n', { mode: 0o755 });
    const helper = writeHelper(scratchDir(), renderHelper(SOURCE, foreign));

    const res = version(helper, nodeDir('real'));

    expect(res.stdout).toContain(HELPER_ID);
    expect(res.status).toBe(0);
  });

  it('keeps the pinned node diagnostic when no fallback node exists', () => {
    const helper = writeHelper(scratchDir(), renderHelper(SOURCE, process.execPath));
    const res = spawnSync(helper, ['version'], {
      encoding: 'utf-8',
      env: { PATH: scratchDir(), NODE_OPTIONS: '--nanoclaw-invalid-option' },
    });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--nanoclaw-invalid-option is not allowed in NODE_OPTIONS');
    expect(res.stderr).not.toContain('node: not found');
  });

  it('leaves stdin for the helper, where docker sends its request', () => {
    // A stand-in node that would swallow stdin during the start test, if it were handed it.
    const standIn = path.join(scratchDir(), 'node');
    fs.writeFileSync(standIn, '#!/bin/sh\nif [ "$1" = "-v" ]; then cat >/dev/null; exit 0; fi\ncat\n', { mode: 0o755 });
    const helper = writeHelper(scratchDir(), renderHelper(SOURCE, standIn));

    const res = spawnSync(helper, ['get'], { encoding: 'utf-8', input: `${HOST}\n`, env: { PATH: '/usr/bin:/bin' } });

    expect(res.stdout).toBe(`${HOST}\n`);
  });
});

describe('refreshInstalledCredentialHelper', () => {
  const olderSetup = `#!${GONE_NODE}\n${SOURCE.slice(SOURCE.indexOf('\n') + 1)}`;

  function install(
    contents: string,
    wiredTo = 'nanoclaw',
  ): { binDir: string; helper: string; dockerConfigPath: string } {
    const binDir = scratchDir();
    const dockerConfigPath = path.join(scratchDir(), 'config.json');
    fs.writeFileSync(dockerConfigPath, `${JSON.stringify({ credHelpers: { [HOST]: wiredTo } }, null, '\t')}\n`);
    return { binDir, helper: writeHelper(binDir, contents), dockerConfigPath };
  }

  it('gives a helper from an older setup the current header, where it is', () => {
    const { binDir, helper, dockerConfigPath } = install(olderSetup);
    const config = fs.readFileSync(dockerConfigPath, 'utf-8');

    refreshInstalledCredentialHelper({ binDir, dockerConfigPath });

    expect(fs.readFileSync(helper, 'utf-8')).toBe(renderHelper(SOURCE, process.execPath));
    expect(fs.readdirSync(binDir)).toEqual([HELPER_BINARY_NAME]);
    expect(fs.readFileSync(dockerConfigPath, 'utf-8')).toBe(config);
    expect(version(helper, nodeDir('broken')).status).toBe(0);
  });

  it('leaves the helper and docker alone when the registry is wired to something else', () => {
    const { binDir, helper, dockerConfigPath } = install(olderSetup, 'ecr-login');
    const config = fs.readFileSync(dockerConfigPath, 'utf-8');

    refreshInstalledCredentialHelper({ binDir, dockerConfigPath });

    expect(fs.readFileSync(dockerConfigPath, 'utf-8')).toBe(config);
    expect(fs.readFileSync(helper, 'utf-8')).toBe(olderSetup);
  });

  it('never writes docker config, even when the same host is also wired elsewhere', () => {
    const { binDir, helper, dockerConfigPath } = install(olderSetup);
    const routes = { credHelpers: { 'REG.example.com': 'nanoclaw', [HOST]: 'ecr-login' } };
    fs.writeFileSync(dockerConfigPath, JSON.stringify(routes));

    refreshInstalledCredentialHelper({ binDir, dockerConfigPath });

    expect(fs.readFileSync(dockerConfigPath, 'utf-8')).toBe(JSON.stringify(routes));
    expect(fs.readFileSync(helper, 'utf-8')).toBe(renderHelper(SOURCE, process.execPath));
  });

  it('rewrites a linked helper at its target and keeps the link', () => {
    const { binDir, helper: link, dockerConfigPath } = install('');
    const target = path.join(scratchDir(), 'helper');
    fs.writeFileSync(target, olderSetup, { mode: 0o755 });
    fs.rmSync(link);
    fs.symlinkSync(target, link);

    refreshInstalledCredentialHelper({ binDir, dockerConfigPath });

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe(renderHelper(SOURCE, process.execPath));
    expect(version(link, nodeDir('broken')).status).toBe(0);
  });

  it('replaces a link to the checkout source without changing that source, even on repeated refresh', () => {
    const { binDir, helper, dockerConfigPath } = install('');
    const source = fs.realpathSync(path.join(here, 'registry', 'credential-helper.mjs'));
    const before = fs.readFileSync(source, 'utf-8');
    fs.rmSync(helper);
    fs.symlinkSync(source, helper);
    // Keep a regression from actually modifying this checkout's source.
    const rename = fs.renameSync.bind(fs);
    const guard = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === source) throw new Error('Attempt to overwrite checkout source');
      rename(from, to);
    });
    try {
      refreshInstalledCredentialHelper({ binDir, dockerConfigPath });
      refreshInstalledCredentialHelper({ binDir, dockerConfigPath });
      expect(fs.lstatSync(helper).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(source, 'utf-8')).toBe(before);
      expect(fs.readFileSync(helper, 'utf-8')).toBe(renderHelper(SOURCE, process.execPath));
      expect(version(helper, nodeDir('broken')).status).toBe(0);
    } finally {
      guard.mockRestore();
    }
  });

  it('preserves the existing helper permissions and ownership on refresh', () => {
    const { binDir, helper, dockerConfigPath } = install(olderSetup);
    fs.chmodSync(helper, 0o710);
    const before = fs.statSync(helper);

    refreshInstalledCredentialHelper({ binDir, dockerConfigPath });

    const after = fs.statSync(helper);
    expect(after.mode & 0o7777).toBe(before.mode & 0o7777);
    expect([after.uid, after.gid]).toEqual([before.uid, before.gid]);
    expect(fs.readFileSync(helper, 'utf-8')).toBe(renderHelper(SOURCE, process.execPath));
  });

  it('leaves the original intact if its ownership cannot be preserved', () => {
    const { binDir, helper, dockerConfigPath } = install(olderSetup);
    const target = fs.realpathSync(helper);
    const stat = fs.lstatSync.bind(fs);
    const metadata = vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
      const result = stat(...args);
      if (String(args[0]) === target) return Object.assign(result, { uid: result.uid + 1 });
      return result;
    });
    const chown = vi.spyOn(fs, 'chownSync').mockImplementation(() => {
      throw Object.assign(new Error('Not permitted'), { code: 'EPERM' });
    });
    try {
      refreshInstalledCredentialHelper({ binDir, dockerConfigPath });
      expect(chown).toHaveBeenCalled();
      expect(fs.readFileSync(helper, 'utf-8')).toBe(olderSetup);
      expect(fs.readdirSync(binDir)).toEqual([HELPER_BINARY_NAME]);
    } finally {
      metadata.mockRestore();
      chown.mockRestore();
    }
  });

  it('does not write through a link that now points at a file that is not the helper', () => {
    const { binDir, dockerConfigPath } = install(olderSetup);
    const other = path.join(scratchDir(), 'notes.txt');
    fs.writeFileSync(other, 'not a helper\n');
    const resolve = vi.spyOn(fs, 'realpathSync').mockReturnValue(other);

    try {
      refreshInstalledCredentialHelper({ binDir, dockerConfigPath });
    } finally {
      resolve.mockRestore();
    }

    expect(fs.readFileSync(other, 'utf-8')).toBe('not a helper\n');
  });

  it('does nothing when no helper is installed', () => {
    const binDir = scratchDir();
    const dockerConfigPath = path.join(scratchDir(), 'config.json');

    refreshInstalledCredentialHelper({ binDir, dockerConfigPath });

    expect(fs.readdirSync(binDir)).toEqual([]);
    expect(fs.existsSync(dockerConfigPath)).toBe(false);
  });

  it('never rewrites a helper it did not install', () => {
    const foreign = `#!${GONE_NODE}\nconsole.log('someone else wrote this');\n`;
    const { binDir, helper, dockerConfigPath } = install(foreign);

    refreshInstalledCredentialHelper({ binDir, dockerConfigPath });

    expect(fs.readFileSync(helper, 'utf-8')).toBe(foreign);
  });

  it('does not fail its caller when the helper it rewrote does not start', () => {
    const { binDir, dockerConfigPath } = install(olderSetup);

    expect(() => withNoNode(() => refreshInstalledCredentialHelper({ binDir, dockerConfigPath }))).not.toThrow();
  });
});

describe('installCredentialHelper', () => {
  it('refuses to wire docker to a helper that does not start', () => {
    const binDir = scratchDir();
    const dockerConfigPath = path.join(scratchDir(), 'config.json');
    const install = (): unknown => installCredentialHelper({ binDir, dockerConfigPath, registryHost: HOST });

    expect(() => withNoNode(install)).toThrow(/did not run after install/);
    expect(fs.existsSync(dockerConfigPath)).toBe(false);
  });
});

// The two setup steps that pull are not run here: they need docker and a
// registry. What can drift unnoticed is the order inside them.
describe('setup rewrites an installed helper before it pulls', () => {
  const PULL = `'container', 'pull.sh')`;
  const CALL = 'refreshInstalledCredentialHelper();';

  it('in the container step', () => {
    const src = fs.readFileSync(path.join(here, 'container.ts'), 'utf-8');

    expect(src.indexOf(CALL)).toBeGreaterThan(src.indexOf(`if (source === 'pull')`));
    expect(src.indexOf(CALL)).toBeLessThan(src.indexOf(PULL));
  });

  it('in the registry refresh', () => {
    const src = fs.readFileSync(path.join(here, 'registry.ts'), 'utf-8');

    expect(src.indexOf(CALL)).toBeGreaterThan(src.indexOf('async function refresh('));
    expect(src.indexOf(CALL)).toBeLessThan(src.indexOf(PULL));
  });
});
