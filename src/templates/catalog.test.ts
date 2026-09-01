import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { isRemote, listTemplates, parseGithubRepo } from './catalog.js';

describe('parseGithubRepo / isRemote (pure)', () => {
  it('parses the standard remote github forms to owner/repo', () => {
    expect(parseGithubRepo('git+https://github.com/nanocoai/nanoclaw-templates')).toEqual({
      owner: 'nanocoai',
      repo: 'nanoclaw-templates',
    });
    expect(parseGithubRepo('https://github.com/o/r')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGithubRepo('https://github.com/o/r.git')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGithubRepo('git@github.com:o/r.git')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGithubRepo('https://github.com/o/r.git#sales/sdr@v2')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGithubRepo('https://gitlab.com/o/r')).toBeNull();
  });

  it('isRemote gates local paths out so a github.com-shaped checkout is read from disk', () => {
    expect(isRemote('/home/me/go/src/github.com/acme/templates')).toBe(false);
    expect(isRemote('./templates')).toBe(false);
    expect(isRemote('~/templates')).toBe(false);
    expect(isRemote('git+https://github.com/o/r')).toBe(true);
    expect(isRemote('git@github.com:o/r.git')).toBe(true);
    expect(isRemote('https://github.com/o/r')).toBe(true);
  });
});

// Local-folder source exercises the no-network path.
describe('catalog (local source)', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-catalog-'));
    fs.mkdirSync(path.join(dir, 'sales', 'sdr'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sales', 'sdr', 'plugin.json'), JSON.stringify({ name: 'sdr' }));

    fs.mkdirSync(path.join(dir, 'support'), { recursive: true });
    // A persona-less plugin is still a complete plugin and must be discoverable.
    fs.writeFileSync(path.join(dir, 'support', 'plugin.json'), JSON.stringify({ name: 'support' }));

    // A folder without the marker must not be listed.
    fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes', 'readme.md'), 'ignore me');
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists only folders holding plugin.json, keyed by ref', async () => {
    const list = await listTemplates(dir);
    expect(list.map((t) => t.ref)).toEqual(['sales/sdr', 'support']);
    expect(list.find((t) => t.ref === 'sales/sdr')?.name).toBe('sdr');
  });

  it('treats the source folder itself as a template (ref ".") when pointed directly at one', async () => {
    const single = path.join(dir, 'sales', 'sdr');
    expect(await listTemplates(single)).toEqual([{ ref: '.', name: 'sdr' }]);
  });
});

// GitHub source = the default/most-traveled path. Stub fetch so the Trees/Contents
// parsing runs without a network or clone.
describe('catalog (github source)', () => {
  const SRC = 'https://github.com/acme/templates';
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(route: (url: string) => { status?: number; json?: unknown }): string[] {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(String(url));
        const r = route(String(url));
        const status = r.status ?? 200;
        return { ok: status < 400, status, statusText: '', json: async () => r.json };
      }),
    );
    return seen;
  }

  it('lists templates from the Trees API without cloning', async () => {
    stubFetch((url) => {
      if (url.includes('/git/trees/HEAD')) {
        return {
          json: {
            truncated: false,
            tree: [
              { type: 'blob', path: 'sales/sdr/plugin.json' },
              { type: 'blob', path: 'support/plugin.json' },
              { type: 'blob', path: 'sales/sdr/README.md' },
            ],
          },
        };
      }
      return { status: 404, json: {} };
    });
    expect((await listTemplates(SRC)).map((t) => t.ref)).toEqual(['sales/sdr', 'support']);
  });

});
