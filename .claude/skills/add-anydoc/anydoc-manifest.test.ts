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
  const installer = readFileSync(join(root, '.claude', 'skills', 'add-anydoc', 'SKILL.md'), 'utf8');
  const removal = readFileSync(join(root, '.claude', 'skills', 'add-anydoc', 'REMOVE.md'), 'utf8');

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

  it('finds bundled files in Claude Code and project-local skill runners', () => {
    expect(installer).toContain('${CLAUDE_SKILL_DIR:-$project_root/.claude/skills/add-anydoc}');
  });

  it('enforces release eligibility before mutation', () => {
    expect(installer).toContain('const version = "0.1.6"');
    expect(installer).toContain('72 * 60 * 60 * 1000');
  });

  it('refreshes a hardened base before rebuilding without AnyDoc', () => {
    expect(removal).toContain('./container/build.sh pull');
    expect(removal.indexOf('./container/build.sh pull')).toBeLessThan(removal.lastIndexOf('./container/build.sh'));
    expect(removal).toContain('command -v anydoc');
  });

  it('rebuilds standard derived group images and rejects foreign pins', () => {
    for (const instructions of [installer, removal]) {
      expect(instructions).toContain('Foreign image pin:');
      expect(instructions).toContain('json_array_length(packages_apt)');
      expect(instructions).toContain('ncl groups get --id "$group_id"');
      expect(instructions).toContain('ncl groups restart --id "$group_id" --rebuild');
    }
    expect(installer.indexOf('ncl groups get --id "$group_id"')).toBeLessThan(installer.indexOf('## Install'));
    expect(removal.indexOf('ncl groups get --id "$group_id"')).toBeLessThan(removal.indexOf('rm -rf container/skills'));
  });

  it('scopes shell permission and creates a unique output directory', () => {
    const skill = readFileSync(skillPath, 'utf8');
    expect(skill).toMatch(/^allowed-tools: Bash\(anydoc:\*\)$/m);
    expect(skill).toContain('mktemp -d');
    expect(skill).not.toContain('/workspace/agent/converted/document.md');
  });

  it('uses local paths consistently across providers', () => {
    const skill = readFileSync(skillPath, 'utf8');
    expect(skill).not.toContain('receives PDFs natively');
    expect(skill).toContain('message-supplied local path for PDFs');
  });

  it('keeps hostile attachment names out of shell expansion', () => {
    const skill = readFileSync(skillPath, 'utf8');
    expect(skill).toContain("input_path='/workspace/inbox/<message-id>/<document>'");
    expect(skill).not.toMatch(/^input_path="/m);
    expect(skill).toContain(`'"'"'`);
    expect(skill).toContain('$(echo unsafe)');
  });
});
