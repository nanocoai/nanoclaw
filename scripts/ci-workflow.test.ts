/**
 * CI runs code from pull requests, so its token stays read-only in the file
 * itself rather than relying on the repository's default token setting.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Permissions = Record<string, string> | 'read-all' | 'write-all' | undefined;

const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')) as {
  permissions?: Permissions;
  jobs: Record<string, { permissions?: Permissions }>;
};

describe('CI workflow token', () => {
  it('sets a read-only default for the whole workflow', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it.each(Object.keys(workflow.jobs))('gives job %s no write scope', (name) => {
    const effective = workflow.jobs[name].permissions ?? workflow.permissions;
    expect(effective).toBeDefined();
    expect(effective).not.toBe('write-all');
    expect(Object.values(effective as Record<string, string>)).not.toContain('write');
  });
});
