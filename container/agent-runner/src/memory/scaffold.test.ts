import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ensureMemoryScaffold } from './scaffold.js';

function parseFrontmatter(filePath: string): unknown {
  const content = fs.readFileSync(filePath, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error(`Missing YAML frontmatter in ${filePath}`);
  return Bun.YAML.parse(match[1]);
}

describe('ensureMemoryScaffold', () => {
  it('deterministically creates the memory tree', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mem-'));
    try {
      ensureMemoryScaffold(base);

      expect(fs.existsSync(path.join(base, 'memory', 'index.md'))).toBe(true);
      expect(fs.existsSync(path.join(base, 'memory', 'system', 'index.md'))).toBe(true);
      expect(fs.existsSync(path.join(base, 'memory', 'system', 'definition.md'))).toBe(true);
      expect(fs.existsSync(path.join(base, 'memory', 'memories'))).toBe(false);
      expect(fs.existsSync(path.join(base, 'memory', 'data'))).toBe(false);
      expect(parseFrontmatter(path.join(base, 'memory', 'index.md'))).toMatchObject({ okf_version: '0.1' });
      expect(parseFrontmatter(path.join(base, 'memory', 'system', 'definition.md'))).toMatchObject({ type: 'system' });
      expect(fs.readFileSync(path.join(base, 'memory', 'system', 'index.md'), 'utf-8')).toContain(
        '[Definition](definition.md)',
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('never imports legacy workspace memory during normal startup', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mem-'));
    try {
      fs.writeFileSync(path.join(base, 'CLAUDE.local.md'), '# group memory\nuser prefers terse replies\n');

      ensureMemoryScaffold(base);

      expect(fs.existsSync(path.join(base, 'memory', 'memories', 'imported-agent-memory.md'))).toBe(false);
      expect(fs.readFileSync(path.join(base, 'CLAUDE.local.md'), 'utf-8')).toContain('terse replies');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('is idempotent and never clobbers the agent edits', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mem-'));
    try {
      ensureMemoryScaffold(base);
      const indexFile = path.join(base, 'memory', 'index.md');
      fs.writeFileSync(indexFile, '# my own index\n');

      ensureMemoryScaffold(base);

      expect(fs.readFileSync(indexFile, 'utf-8')).toBe('# my own index\n');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('leaves legacy memory folders and their contents untouched', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mem-'));
    try {
      const legacyFile = path.join(base, 'memory', 'memories', 'legacy.md');
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, 'keep me\n');

      ensureMemoryScaffold(base);

      expect(fs.readFileSync(legacyFile, 'utf-8')).toBe('keep me\n');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
