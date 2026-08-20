import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function repoRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(directory, 'container', 'cli-tools.json'))) return directory;
    directory = dirname(directory);
  }
  throw new Error('container/cli-tools.json not found');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

describe('the AnyDoc CLI integration', () => {
  const root = repoRoot();
  const parsedManifest: unknown = JSON.parse(readFileSync(join(root, 'container', 'cli-tools.json'), 'utf8'));
  if (!Array.isArray(parsedManifest)) throw new Error('container/cli-tools.json must be an array');
  const manifest: unknown[] = parsedManifest;
  const anydocEntries = manifest.filter(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.name === '@firecrawl/anydoc',
  );
  const skillPath = join(root, 'container', 'skills', 'convert-documents-to-markdown', 'SKILL.md');

  it('contains exactly one AnyDoc manifest entry', () => {
    expect(anydocEntries).toHaveLength(1);
  });

  it('pins the approved AnyDoc version without lifecycle-script opt-in', () => {
    expect(anydocEntries[0]).toEqual({ name: '@firecrawl/anydoc', version: '0.1.6' });
  });

  it('ships the matching container skill', () => {
    expect(existsSync(skillPath)).toBe(true);
  });

  it('teaches the installed command without runtime package resolution', () => {
    const skill = readFileSync(skillPath, 'utf8');
    expect(skill).toMatch(/\banydoc\s+-o\s+/);
    expect(skill).not.toMatch(/\bnpx(?:\s|$)/);
  });
});
