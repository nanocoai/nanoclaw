import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { MEMORY_FILE_BUDGET_CHARS, MEMORY_TRUNCATION_NOTICE, renderMemorySection } from './context.js';

const BASE = '/tmp/nanoclaw-memory-context-test';

function writeMemoryTree(index: string, definition: string): void {
  fs.mkdirSync(path.join(BASE, 'memory', 'system'), { recursive: true });
  fs.writeFileSync(path.join(BASE, 'memory', 'index.md'), index);
  fs.writeFileSync(path.join(BASE, 'memory', 'system', 'definition.md'), definition);
}

beforeEach(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(BASE, { recursive: true });
});

afterEach(() => fs.rmSync(BASE, { recursive: true, force: true }));

describe('renderMemorySection', () => {
  it('inlines existing untyped memory without blocking it', () => {
    writeMemoryTree('# Memory Index\n- [Casa](projects/casa.md)\n', 'custom doctrine\n');

    const section = renderMemorySection(BASE);

    expect(section).toContain('## Memory');
    expect(section).toContain('files on disk are authoritative');
    expect(section).toContain('Open Knowledge Format (OKF) v0.1 bundle');
    expect(section).toContain('- [Casa](projects/casa.md)');
    expect(section).toContain('custom doctrine');
  });

  it('degrades without throwing when a file is missing', () => {
    fs.mkdirSync(path.join(BASE, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(BASE, 'memory', 'index.md'), '# Memory Index\n');

    expect(renderMemorySection(BASE)).toContain('unavailable during this hook invocation');
  });

  it('truncates each file independently without splitting a surrogate pair', () => {
    const prefix = 'x'.repeat(MEMORY_FILE_BUDGET_CHARS - 1);
    writeMemoryTree(`${prefix}\ud83d\ude00tail`, 'y'.repeat(MEMORY_FILE_BUDGET_CHARS + 1));

    const section = renderMemorySection(BASE);

    expect(section.match(/\[truncated:/g)).toHaveLength(2);
    expect(section).toContain(MEMORY_TRUNCATION_NOTICE);
    expect(section).not.toContain('\ud83d\n');
  });
});
