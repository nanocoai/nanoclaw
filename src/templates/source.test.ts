import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_TEMPLATES_SOURCE, parseTemplateRef, resolveTemplateSource } from './source.js';

describe('parseTemplateRef', () => {
  it('classifies local path prefixes as file', () => {
    expect(parseTemplateRef('./x')).toMatchObject({ scheme: 'file', base: './x' });
    expect(parseTemplateRef('/abs/x')).toMatchObject({ scheme: 'file', base: '/abs/x' });
  });

  it('resolves a bare name under the default source as a subpath', () => {
    expect(parseTemplateRef('sales/sdr')).toMatchObject({
      scheme: 'git',
      base: DEFAULT_TEMPLATES_SOURCE,
      subpath: 'sales/sdr',
    });
    expect(parseTemplateRef('sales/sdr').ref).toBeUndefined();
  });

  it('splits a trailing @ref off a bare name', () => {
    expect(parseTemplateRef('sales/sdr@v2')).toMatchObject({
      scheme: 'git',
      base: DEFAULT_TEMPLATES_SOURCE,
      subpath: 'sales/sdr',
      ref: 'v2',
    });
  });

  it('lets --source override the base for a bare ref only', () => {
    const override = 'git+https://github.com/acme/my-templates';
    expect(parseTemplateRef('sdr', override)).toMatchObject({ scheme: 'git', base: override, subpath: 'sdr' });
    // An explicit URI ignores the override.
    expect(parseTemplateRef('git+https://h/r.git', override)).toMatchObject({ base: 'git+https://h/r.git' });
  });

  it('parses an explicit git URI with subpath and ref', () => {
    expect(parseTemplateRef('git+https://h/r.git#sub@v1')).toMatchObject({
      scheme: 'git',
      base: 'git+https://h/r.git',
      subpath: 'sub',
      ref: 'v1',
    });
  });

  it('keeps an SSH git@ ref intact (no false @ref split)', () => {
    const loc = parseTemplateRef('git@github.com:org/repo.git');
    expect(loc).toMatchObject({ scheme: 'git', base: 'git@github.com:org/repo.git' });
    expect(loc.ref).toBeUndefined();
  });

  it('normalizes a plain http(s)/ssh URL to a git repo so git+ is optional', () => {
    expect(parseTemplateRef('https://github.com/org/repo')).toMatchObject({
      scheme: 'git',
      base: 'git+https://github.com/org/repo',
    });
    expect(parseTemplateRef('https://github.com/org/repo#sales/sdr')).toMatchObject({
      scheme: 'git',
      base: 'git+https://github.com/org/repo',
      subpath: 'sales/sdr',
    });
    // ...and as a --source override for a bare ref.
    expect(parseTemplateRef('sdr', 'https://github.com/org/repo')).toMatchObject({
      scheme: 'git',
      base: 'git+https://github.com/org/repo',
      subpath: 'sdr',
    });
  });
});

describe('resolveTemplateSource', () => {
  it('resolves a local path to a directory with a no-op cleanup', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-src-'));
    try {
      const resolved = await resolveTemplateSource(tmp);
      expect(resolved.dir).toBe(path.resolve(tmp));
      expect(() => resolved.cleanup()).not.toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws for an unsupported source scheme', async () => {
    await expect(resolveTemplateSource('sdr', 's3://bucket/templates')).rejects.toThrow(/unsupported template source/);
  });
});
