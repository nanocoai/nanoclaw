import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { markMemoryLoaded, memoryChangedSince } from './staleness.js';

function withTree(run: (marker: string, base: string, write: (rel: string, body: string) => void) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-staleness-'));
  try {
    run(path.join(base, '.memory-loaded'), base, (rel, body) => {
      const full = path.join(base, 'memory', rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/** mtime resolution is coarse enough that same-tick writes can tie. */
function tick(): void {
  const until = Date.now() + 12;
  while (Date.now() < until) {
    /* spin */
  }
}

const DEFINITION = path.join('system', 'definition.md');

describe('memory staleness', () => {
  it('says nothing before memory has ever been loaded', () => {
    withTree((marker, base, write) => {
      write('index.md', '# Index\n');
      expect(memoryChangedSince(base, marker)).toEqual([]);
    });
  });

  it('says nothing while the loaded files are older than the load', () => {
    withTree((marker, base, write) => {
      write('index.md', '# Index\n');
      write(DEFINITION, '# Definition\n');
      tick();
      markMemoryLoaded(marker);

      expect(memoryChangedSince(base, marker)).toEqual([]);
    });
  });

  it('names each injected file rewritten after the load', () => {
    withTree((marker, base, write) => {
      write('index.md', '# Index\n');
      write(DEFINITION, '# Definition\n');
      markMemoryLoaded(marker);
      tick();
      write('index.md', '# Index\n- deploys on Fridays are banned\n');
      write(DEFINITION, '# Definition\n- reorganized\n');

      expect(memoryChangedSince(base, marker)).toEqual(['index.md', DEFINITION]);
    });
  });

  it('ignores leaf files, which are not the copy in context', () => {
    withTree((marker, base, write) => {
      write('index.md', '# Index\n');
      markMemoryLoaded(marker);
      tick();
      write('topics/rollback.md', '# Rollback\n');

      expect(memoryChangedSince(base, marker)).toEqual([]);
    });
  });

  it('re-stamping absorbs the edits, so they are reported once', () => {
    withTree((marker, base, write) => {
      markMemoryLoaded(marker);
      tick();
      write('index.md', '# Index\n');
      expect(memoryChangedSince(base, marker)).toEqual(['index.md']);

      // What the poll loop does after each turn.
      tick();
      markMemoryLoaded(marker);

      expect(memoryChangedSince(base, marker)).toEqual([]);
    });
  });

  it('stays quiet instead of throwing when memory/ is absent', () => {
    withTree((marker) => {
      markMemoryLoaded(marker);
      expect(memoryChangedSince(path.join(marker, 'nope'), marker)).toEqual([]);
    });
  });
});
