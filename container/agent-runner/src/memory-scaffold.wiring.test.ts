import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

// Wiring guard for the memory-scaffold seam: the boot gate in index.ts
// (`if (provider.usesMemoryScaffold) ensureMemoryScaffold()`) is the seam's
// single functional reach-in. The unit tests in memory-scaffold.test.ts drive
// ensureMemoryScaffold directly and stay green if the gate is deleted — this
// test goes red. main() can't be driven in-process (it reads
// /workspace/agent/container.json and enters the poll loop), so the guard is
// structural: gate + import must both be present in the real entry point.
describe('memory scaffold boot wiring', () => {
  const indexSrc = fs.readFileSync(path.join(import.meta.dir, 'index.ts'), 'utf-8');

  it('gates the scaffold on the provider capability in main()', () => {
    expect(indexSrc).toContain('if (provider.usesMemoryScaffold) ensureMemoryScaffold()');
  });

  it('imports ensureMemoryScaffold from the seam module', () => {
    expect(indexSrc).toContain("import { ensureMemoryScaffold } from './memory-scaffold.js'");
  });
});
