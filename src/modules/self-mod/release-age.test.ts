import { describe, expect, it } from 'vitest';

import { checkNpmReleaseAge, parseSpec, DEFAULT_RELEASE_AGE_MS } from './release-age.js';

const NOW = Date.parse('2026-06-11T00:00:00Z');

function fakeFetch(map: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const name = decodeURIComponent(String(url).split('/').pop() as string);
    const body = map[name];
    if (!body) return { ok: false, status: 404, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;
}

describe('parseSpec', () => {
  it('parses unversioned', () => {
    expect(parseSpec('left-pad')).toEqual({ name: 'left-pad', version: null });
  });
  it('parses versioned', () => {
    expect(parseSpec('left-pad@1.3.0')).toEqual({ name: 'left-pad', version: '1.3.0' });
  });
  it('parses scoped versioned', () => {
    expect(parseSpec('@scope/pkg@2.0.0')).toEqual({ name: '@scope/pkg', version: '2.0.0' });
  });
  it('parses scoped unversioned', () => {
    expect(parseSpec('@scope/pkg')).toEqual({ name: '@scope/pkg', version: null });
  });
});

describe('checkNpmReleaseAge', () => {
  const oldPkg = { 'dist-tags': { latest: '1.0.0' }, time: { '1.0.0': '2026-01-01T00:00:00Z' } };
  const newPkg = { 'dist-tags': { latest: '9.9.9' }, time: { '9.9.9': '2026-06-10T20:00:00Z' } };

  it('passes a package older than the threshold', async () => {
    const r = await checkNpmReleaseAge(['old'], {
      thresholdMs: DEFAULT_RELEASE_AGE_MS,
      overrides: [],
      now: NOW,
      fetchImpl: fakeFetch({ old: oldPkg }),
    });
    expect(r.violations).toHaveLength(0);
    expect(r.unverifiable).toHaveLength(0);
    expect(r.resolved[0]).toEqual({ name: 'old', version: '1.0.0', publishedAt: '2026-01-01T00:00:00Z' });
  });

  it('flags a package newer than the threshold', async () => {
    const r = await checkNpmReleaseAge(['new'], {
      thresholdMs: DEFAULT_RELEASE_AGE_MS,
      overrides: [],
      now: NOW,
      fetchImpl: fakeFetch({ new: newPkg }),
    });
    expect(r.violations.map((p) => p.name)).toEqual(['new']);
  });

  it('exempts a too-new package present in the exact-pinned override list', async () => {
    const r = await checkNpmReleaseAge(['new@9.9.9'], {
      thresholdMs: DEFAULT_RELEASE_AGE_MS,
      overrides: ['new@9.9.9'],
      now: NOW,
      fetchImpl: fakeFetch({ new: newPkg }),
    });
    expect(r.violations).toHaveLength(0);
  });

  it('reports a package as unverifiable when the registry lookup fails (fail closed)', async () => {
    const r = await checkNpmReleaseAge(['ghost'], {
      thresholdMs: DEFAULT_RELEASE_AGE_MS,
      overrides: [],
      now: NOW,
      fetchImpl: fakeFetch({}),
    });
    expect(r.unverifiable).toEqual(['ghost']);
  });
});
