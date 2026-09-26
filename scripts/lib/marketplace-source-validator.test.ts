import { describe, it, expect } from 'vitest';
import {
  validateMarketplaceSource,
  parseMarketplaceSource,
} from './marketplace-source-validator.js';

describe('validateMarketplaceSource — accepts every documented variant', () => {
  it.each([
    ['url with required fields', { source: 'url', url: 'https://x.com/m.json' }],
    ['url with optional headers', {
      source: 'url',
      url: 'https://x.com/m.json',
      headers: { Authorization: 'Bearer x' },
    }],
    ['github with repo only', { source: 'github', repo: 'owner/repo' }],
    ['github with all fields', {
      source: 'github',
      repo: 'owner/repo',
      ref: 'main',
      path: 'sub/dir',
      sparsePaths: ['plugins'],
    }],
    ['git with url only', { source: 'git', url: 'https://gitlab.com/x/y.git' }],
    ['git with sparsePaths', {
      source: 'git',
      url: 'git@host:x/y.git',
      sparsePaths: ['a', 'b'],
    }],
    ['npm', { source: 'npm', package: '@scope/pkg' }],
    ['file', { source: 'file', path: '/abs/path/marketplace.json' }],
    ['directory', { source: 'directory', path: '/abs/path/' }],
    ['hostPattern', { source: 'hostPattern', hostPattern: '^github\\.com$' }],
    ['pathPattern', { source: 'pathPattern', pathPattern: '.*' }],
    ['settings', { source: 'settings', name: 'my-mp', plugins: [{ name: 'p' }] }],
  ])('accepts %s', (_label, input) => {
    const r = validateMarketplaceSource(input);
    expect(r.ok).toBe(true);
  });
});

describe('validateMarketplaceSource — rejects bad inputs', () => {
  it('rejects null', () => {
    const r = validateMarketplaceSource(null);
    expect(r.ok).toBe(false);
  });

  it('rejects array (top-level non-object)', () => {
    const r = validateMarketplaceSource([1, 2]);
    expect(r.ok).toBe(false);
  });

  it('rejects unknown source type', () => {
    const r = validateMarketplaceSource({ source: 'wat' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown source type/);
  });

  it('rejects missing source field', () => {
    const r = validateMarketplaceSource({ url: 'https://x' });
    expect(r.ok).toBe(false);
  });

  it('rejects github with malformed repo', () => {
    const r = validateMarketplaceSource({ source: 'github', repo: 'no-slash' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/owner\/repo/);
  });

  it('rejects github with empty repo', () => {
    const r = validateMarketplaceSource({ source: 'github', repo: '' });
    expect(r.ok).toBe(false);
  });

  it('rejects url with no url field', () => {
    const r = validateMarketplaceSource({ source: 'url' });
    expect(r.ok).toBe(false);
  });

  it('rejects url with non-string headers', () => {
    const r = validateMarketplaceSource({
      source: 'url',
      url: 'https://x',
      headers: { auth: 123 },
    });
    expect(r.ok).toBe(false);
  });

  it('rejects npm with missing package', () => {
    const r = validateMarketplaceSource({ source: 'npm' });
    expect(r.ok).toBe(false);
  });

  it('rejects settings without plugins array', () => {
    const r = validateMarketplaceSource({ source: 'settings', name: 'x' });
    expect(r.ok).toBe(false);
  });
});

describe('parseMarketplaceSource throws on invalid', () => {
  it('throws on bad source', () => {
    expect(() => parseMarketplaceSource({ source: 'wat' })).toThrow(/Invalid marketplace source/);
  });
  it('returns typed source on valid', () => {
    const s = parseMarketplaceSource({ source: 'github', repo: 'a/b', ref: 'main' });
    expect(s.source).toBe('github');
    if (s.source === 'github') {
      expect(s.repo).toBe('a/b');
      expect(s.ref).toBe('main');
    }
  });
});
