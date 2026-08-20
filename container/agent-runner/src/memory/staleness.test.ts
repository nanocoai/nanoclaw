import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { fingerprintMemoryTree, memoryChangeNotice } from './staleness.js';

function withTree(run: (write: (relPath: string, content: string) => void, baseDir: string) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-staleness-'));
  try {
    run((relPath, content) => {
      const full = path.join(base, 'memory', relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }, base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

describe('fingerprintMemoryTree', () => {
  it('stamps every file in the tree by relative path, and nothing else', () => {
    withTree((write, base) => {
      write('index.md', '# Index\n');
      write('topics/nested/deep.md', 'deep\n');
      // A symlink must not be stamped, and must not be followed out of the tree.
      const outside = path.join(base, 'outside.md');
      fs.writeFileSync(outside, 'outside\n');
      fs.symlinkSync(outside, path.join(base, 'memory', 'link.md'));

      expect(fingerprintMemoryTree(base).split('\n').map((line) => line.split('\t')[0])).toEqual([
        'index.md',
        path.join('topics', 'nested', 'deep.md'),
      ]);
    });
  });

  it('fingerprints a missing tree as empty instead of throwing', () => {
    withTree((_write, base) => expect(fingerprintMemoryTree(base)).toBe(''));
  });
});

describe('memoryChangeNotice', () => {
  it('stays silent on a session first turn, when no baseline exists yet', () => {
    withTree((write, base) => {
      write('index.md', '# Index\n');
      expect(memoryChangeNotice(undefined, base)).toBeUndefined();
    });
  });

  it('treats an empty baseline as a real one, so a first memory file is reported', () => {
    withTree((write, base) => {
      write('index.md', '# Index\n');
      expect(memoryChangeNotice('', base)).toContain('added: memory/index.md');
    });
  });

  it('stays silent when the tree still matches the baseline', () => {
    withTree((write, base) => {
      write('index.md', '# Index\n');
      expect(memoryChangeNotice(fingerprintMemoryTree(base), base)).toBeUndefined();
    });
  });

  it('names files edited, added, and removed since the baseline', () => {
    withTree((write, base) => {
      write('index.md', 'one\n');
      write('gone.md', 'bye\n');
      const baseline = fingerprintMemoryTree(base);

      write('index.md', 'two but longer\n');
      write('topics/new.md', 'fresh\n');
      fs.rmSync(path.join(base, 'memory', 'gone.md'));

      const notice = memoryChangeNotice(baseline, base) ?? '';

      expect(notice).toContain('modified: memory/index.md');
      expect(notice).toContain(`added: memory/${path.join('topics', 'new.md')}`);
      expect(notice).toContain('removed: memory/gone.md');
      expect(notice).toStartWith('<memory_changed>');
      expect(notice).toEndWith('</memory_changed>');
    });
  });

  it('summarizes the tail past the naming cap', () => {
    withTree((write, base) => {
      const baseline = fingerprintMemoryTree(base);
      for (let i = 0; i < 13; i++) write(`file-${String(i).padStart(2, '0')}.md`, 'x\n');

      const notice = memoryChangeNotice(baseline, base) ?? '';

      expect(notice).toContain('file-00.md');
      expect(notice).toContain('...and 3 more');
      expect(notice).not.toContain('file-12.md');
    });
  });
});
