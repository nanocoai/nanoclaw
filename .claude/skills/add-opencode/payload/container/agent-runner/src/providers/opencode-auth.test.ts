import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeOpenCodeAuth } from './opencode-auth.js';

const roots: string[] = [];
function root() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-auth-'));
  roots.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('container-owned OpenCode auth state', () => {
  it('creates fresh OAuth placeholders and resets stale state before a restart', () => {
    const directory = root();
    const auth = path.join(directory, 'opencode/auth.json');
    initializeOpenCodeAuth(directory, 'chatgpt');
    const expected = {
      openai: { type: 'oauth', access: 'onecli-managed', refresh: 'onecli-managed', expires: Date.UTC(2100, 0, 1) },
    };
    expect(JSON.parse(fs.readFileSync(auth, 'utf8'))).toEqual(expected);
    fs.writeFileSync(auth, '{corrupt or stale');
    initializeOpenCodeAuth(directory, 'chatgpt');
    expect(JSON.parse(fs.readFileSync(auth, 'utf8'))).toEqual(expected);
    expect(fs.statSync(auth).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(auth))).toEqual(['auth.json']);
  });

  it('clears OAuth on switching to API-key mode and restores it on switching back', () => {
    const directory = root();
    const auth = path.join(directory, 'opencode/auth.json');
    initializeOpenCodeAuth(directory, 'chatgpt');
    initializeOpenCodeAuth(directory, 'api-key');
    expect(JSON.parse(fs.readFileSync(auth, 'utf8'))).toEqual({});
    initializeOpenCodeAuth(directory, 'chatgpt');
    expect(JSON.parse(fs.readFileSync(auth, 'utf8')).openai.type).toBe('oauth');
  });

  it('replaces planted file links without overwriting their targets', () => {
    const directory = root();
    const unrelated = path.join(directory, 'unrelated');
    fs.writeFileSync(unrelated, 'preserve');
    fs.mkdirSync(path.join(directory, 'opencode'));
    const auth = path.join(directory, 'opencode/auth.json');
    fs.symlinkSync(unrelated, auth);
    initializeOpenCodeAuth(directory, 'chatgpt');
    expect(fs.lstatSync(auth).isFile()).toBe(true);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('preserve');
  });

  it('rejects a symlinked auth directory without writing through it', () => {
    const directory = root();
    const target = root();
    fs.symlinkSync(target, path.join(directory, 'opencode'));
    expect(() => initializeOpenCodeAuth(directory, 'chatgpt')).toThrow('not symlinks');
    expect(fs.readdirSync(target)).toEqual([]);
  });
  it('rejects a linked data root before creating an auth directory in its target', () => {
    const directory = root();
    const target = root();
    const linked = path.join(directory, 'data');
    fs.symlinkSync(target, linked);
    expect(() => initializeOpenCodeAuth(linked, 'chatgpt')).toThrow('not symlinks');
    expect(fs.readdirSync(target)).toEqual([]);
  });
});
