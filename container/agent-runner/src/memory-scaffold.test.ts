import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ensureMemoryScaffold } from './memory-scaffold.js';

describe('ensureMemoryScaffold', () => {
  it('deterministically creates the memory tree', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mem-'));
    try {
      ensureMemoryScaffold(base);

      expect(fs.existsSync(path.join(base, 'memory', 'index.md'))).toBe(true);
      expect(fs.existsSync(path.join(base, 'memory', 'system', 'definition.md'))).toBe(true);
      expect(fs.existsSync(path.join(base, 'memory', 'memories'))).toBe(true);
      expect(fs.existsSync(path.join(base, 'memory', 'data'))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('never touches workspace memory it did not create — CLAUDE.local.md stays untouched', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mem-'));
    try {
      fs.writeFileSync(path.join(base, 'CLAUDE.local.md'), '# group memory\nuser prefers terse replies\n');

      ensureMemoryScaffold(base);

      // Migration between memory stores is the operator's move (/migrate-memory),
      // never a boot side effect.
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
});
