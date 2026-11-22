import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('the deja CLI integration', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(readFileSync(join(root, 'container', 'cli-tools.json'), 'utf8')) as unknown[];
  const dejaEntries = manifest.filter(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.name === '@vshulcz/deja-vu',
  );
  const skillPath = join(root, 'container', 'skills', 'search-past-sessions', 'SKILL.md');

  it('contains exactly one @vshulcz/deja-vu manifest entry', () => {
    expect(dejaEntries).toHaveLength(1);
    const entry = dejaEntries[0];
    expect(typeof entry.version).toBe('string');
    expect(entry.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
    expect(entry.onlyBuilt).not.toBe(true);
  });

  it('ships the container search-past-sessions skill', () => {
    expect(existsSync(skillPath)).toBe(true);
  });

  it('scopes shell permission, persists the index under .claude, and avoids npx', () => {
    const skill = readFileSync(skillPath, 'utf8');
    expect(skill).toMatch(/^allowed-tools: Bash\(deja:\*\)$/m);
    expect(skill).toContain('DEJA_INDEX_DIR=/home/node/.claude/.deja-index');
    expect(skill).toMatch(/\bdeja\s+index\s+--quiet\b/);
    expect(skill).toMatch(/\bdeja\s+recall\b/);
    expect(skill).not.toMatch(/\bnpx(?:\s|$)/);
  });
});
