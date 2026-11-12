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

import { afterEach, describe, expect, it } from 'vitest';

import { HELPER_BINARY_NAME, refreshInstalledCredentialHelper, renderHelper } from './install-cred-helper.js';

const SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'registry', 'credential-helper.mjs'),
  'utf-8',
);
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
});
