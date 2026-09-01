/**
 * The materials layout — the arithmetic two different worlds have to agree on.
 *
 * The driver mints a child kubeconfig to a host path and hands it out by
 * reference; the host mounts the owner's slice of that tree into the sandbox
 * that claimed it. A slug that is not a legal label value fails the CLAIM
 * (the driver writes it onto the runtime), and a slug that collides hands one
 * owner another owner's cluster-admin credentials — so the edges are the
 * whole point here, not an afterthought.
 */
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { materialsPath, materialsScopeSlug } from './materials.js';

/** The k8s label-value grammar, which is also what the driver's own check enforces. */
const LABEL_VALUE_RE = /^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;

describe('materialsScopeSlug', () => {
  it('leaves an ordinary owner ref alone', () => {
    expect(materialsScopeSlug('ag-code-mode-test')).toBe('ag-code-mode-test');
    expect(materialsScopeSlug('operator')).toBe('operator');
  });

  it('keeps owners that sanitize to the same thing apart', () => {
    // The leak this prevents: two owners sharing one directory, and with it
    // every child kubeconfig either of them ever claimed.
    expect(materialsScopeSlug('a/b')).not.toBe(materialsScopeSlug('a-b'));
    expect(materialsScopeSlug('A')).not.toBe(materialsScopeSlug('a'));
  });

  it('stays inside the label bound at every length boundary', () => {
    for (const length of [1, 53, 54, 55, 62, 63, 64, 200]) {
      const slug = materialsScopeSlug('a'.repeat(length));
      expect(slug.length, `length ${length}`).toBeLessThanOrEqual(63);
      expect(slug, `length ${length}`).toMatch(LABEL_VALUE_RE);
    }
  });

  it('is idempotent, including in the truncated branch', () => {
    // The driver stores the slug on the runtime and re-derives paths from it,
    // so slugging a slug has to be the identity or the path moves.
    for (const scope of ['ag-one', 'a'.repeat(64), 'a/b', '../../etc', '  ', 'A'.repeat(90)]) {
      const once = materialsScopeSlug(scope);
      expect(materialsScopeSlug(once), scope).toBe(once);
    }
  });

  it('never yields a path segment that escapes, hides, or empties', () => {
    for (const scope of ['../../etc', '.', '..', '/', '', '   ', '.hidden']) {
      const slug = materialsScopeSlug(scope);
      expect(slug, scope).not.toContain('/');
      expect(slug, scope).not.toContain('..');
      expect(slug.startsWith('.'), scope).toBe(false);
      expect(slug.length, scope).toBeGreaterThan(0);
    }
  });
});

describe('materialsPath', () => {
  it('nests instance directories under their owner, and stays under the root', () => {
    const root = '/srv/install/data/dev-env';
    expect(materialsPath(root, 'ag-one')).toBe(path.join(root, 'ag-one'));
    expect(materialsPath(root, 'ag-one', 'ins-42')).toBe(path.join(root, 'ag-one', 'ins-42'));
    for (const [scope, instance] of [
      ['../../etc', 'ins-42'],
      ['ag-one', '../../../etc'],
    ] as const) {
      expect(materialsPath(root, scope, instance).startsWith(`${root}${path.sep}`)).toBe(true);
    }
  });
});
