// Behavior tests for the save commands in the OneCLI upgrade guide.
//
// The guide is handed to a coding agent verbatim, so its one-liners are the
// product. These tests take the two commands that write ONECLI_VERSION to
// ~/.onecli/.env (upgrade and rollback) OUT of the guide, fill the placeholder,
// and run them against a throwaway HOME. An empty value must never reach the
// file: the stock compose file then falls back to `latest`.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const GUIDE = path.resolve(__dirname, '../.claude/skills/add-onecli/payload/docs/onecli-upgrades.md');
const saveLines = fs
  .readFileSync(GUIDE, 'utf8')
  .split('\n')
  .filter((l) => l.includes('echo "ONECLI_VERSION=$P"'));
const saveLine = (placeholder: RegExp): string => {
  const hits = saveLines.filter((l) => placeholder.test(l));
  if (hits.length !== 1) throw new Error(`expected exactly one save command for ${placeholder}, found ${hits.length}`);
  return hits[0];
};
const UPGRADE = /P=<onecli-gateway pin from [^>]+>/;
const ROLLBACK = /P=<old-version>/;

let home: string;
let envFile: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-guide-'));
  fs.mkdirSync(path.join(home, '.onecli'));
  envFile = path.join(home, '.onecli', '.env');
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function save(placeholder: RegExp, value: string, shell = 'sh') {
  const cmd = saveLine(placeholder).replace(placeholder, () => `P=${value}`);
  return spawnSync(shell, ['-c', cmd], { env: { PATH: process.env.PATH ?? '', HOME: home }, encoding: 'utf8' });
}

describe('OneCLI upgrade guide: save commands', () => {
  it('names the pin file by its full path in every placeholder', () => {
    const guide = fs.readFileSync(GUIDE, 'utf8');
    expect(guide).not.toMatch(/pin from versions\.json/);
    expect(saveLines).toHaveLength(2);
  });

  it('backs up the gateway database before the pull and restart', () => {
    const guide = fs.readFileSync(GUIDE, 'utf8');
    const backup = guide.split('\n').filter((l) => l.includes('pg_dump'));
    expect(backup).toHaveLength(1);
    expect(backup[0]).not.toMatch(/!|\s#\s/);
    expect(guide.indexOf(backup[0])).toBeLessThan(guide.indexOf('docker compose pull onecli'));
    expect(spawnSync('sh', ['-n', '-c', backup[0]]).status).toBe(0);
  });

  // `docker` is a stub that prints what a complete, cut-off, or failed dump would.
  it.each([
    ['complete', 'echo "-- PostgreSQL database dump complete"', true],
    ['cut off', 'echo "CREATE TABLE x"', false],
    ['failed', 'echo "CREATE TABLE x"; exit 1', false],
  ])('backup keeps the file only for a complete dump: %s', (_name, body, kept) => {
    const backup = fs
      .readFileSync(GUIDE, 'utf8')
      .split('\n')
      .filter((l) => l.includes('pg_dump'))[0];
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const r = spawnSync('sh', ['-c', backup], {
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home },
      encoding: 'utf8',
    });
    const files = fs.readdirSync(home).filter((f) => f.startsWith('onecli-db-backup-'));
    expect(r.status === 0).toBe(kept);
    expect(files).toHaveLength(kept ? 1 : 0);
    if (kept) expect(fs.statSync(path.join(home, files[0])).mode & 0o777).toBe(0o600);
    else expect(r.stderr).toContain('Backup failed, nothing saved');
  });

  // An unquoted `!` is history expansion when pasted into interactive zsh or bash.
  // So is a trailing `#` comment in zsh, where it is a parse error.
  it('save commands contain no `!` and no trailing comment', () => {
    for (const l of saveLines) expect(l).not.toMatch(/!|\s#\s/);
  });

  it('a refused rollback save does not go on to restart the gateway', () => {
    fs.writeFileSync(envFile, 'ONECLI_VERSION=\n');
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "$@" >> "${home}/docker.log"\n`, { mode: 0o755 });
    const cmd = saveLine(ROLLBACK).replace(ROLLBACK, 'P=');
    const r = spawnSync('sh', ['-c', cmd], {
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home },
      encoding: 'utf8',
    });
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(path.join(home, 'docker.log'))).toBe(false);
  });

  for (const shell of ['sh', 'bash']) {
    it(`upgrade save writes the pin and keeps other settings (${shell})`, () => {
      fs.writeFileSync(envFile, 'ONECLI_BIND_HOST=172.17.0.1\nONECLI_VERSION=1.41.0\n', { mode: 0o600 });
      const r = save(UPGRADE, '1.42.0', shell);
      expect(r.status).toBe(0);
      expect(fs.readFileSync(envFile, 'utf8')).toBe('ONECLI_BIND_HOST=172.17.0.1\nONECLI_VERSION=1.42.0\n');
      expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    });

    it(`upgrade save refuses an empty pin and leaves .env alone (${shell})`, () => {
      const before = 'ONECLI_BIND_HOST=172.17.0.1\nONECLI_VERSION=1.41.0\n';
      fs.writeFileSync(envFile, before);
      const r = save(UPGRADE, '', shell);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('Not saved');
      expect(fs.readFileSync(envFile, 'utf8')).toBe(before);
      expect(fs.existsSync(`${envFile}.new`)).toBe(false);
    });
  }

  it('upgrade save does not create .env when the pin is empty', () => {
    expect(save(UPGRADE, '').status).not.toBe(0);
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it.each(['latest', 'null', '1.42', '1..42', '.1.42', '1.42.', 'v1.42.0', '"1.42.0 x"'])(
    'upgrade save refuses a non-version value: %s',
    (value) => {
      fs.writeFileSync(envFile, 'ONECLI_VERSION=1.41.0\n');
      expect(save(UPGRADE, value).status).not.toBe(0);
      expect(fs.readFileSync(envFile, 'utf8')).toBe('ONECLI_VERSION=1.41.0\n');
    },
  );

  it.each(['1.41.0', 'rollback'])('rollback save accepts %s', (value) => {
    fs.writeFileSync(envFile, 'ONECLI_VERSION=1.42.0\n');
    // Keep only the save: the rest of the line restarts the gateway.
    const cmd = saveLine(ROLLBACK)
      .replace(ROLLBACK, () => `P=${value}`)
      .replace(/\) && env -u .*$/, ')');
    expect(spawnSync('sh', ['-c', cmd], { env: { PATH: process.env.PATH ?? '', HOME: home } }).status).toBe(0);
    expect(fs.readFileSync(envFile, 'utf8')).toBe(`ONECLI_VERSION=${value}\n`);
  });

  it.each(['', 'latest', '"1.41.0 x"'])('rollback save refuses: [%s]', (value) => {
    fs.writeFileSync(envFile, 'ONECLI_VERSION=1.42.0\n');
    const r = save(ROLLBACK, value);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Not saved');
    expect(fs.readFileSync(envFile, 'utf8')).toBe('ONECLI_VERSION=1.42.0\n');
  });

  it('the migration warning sends the reader back to the pin, not to the old version', () => {
    const warning = fs
      .readFileSync(GUIDE, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('**If a gateway newer than the pin'));
    expect(warning).toContain('back on the pin (step 2)');
    expect(warning).not.toContain('step 4');
  });
});
