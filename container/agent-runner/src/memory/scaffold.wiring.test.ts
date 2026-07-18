import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

// The unit tests drive ensureMemoryScaffold directly and stay green if the boot
// call is deleted. main() can't be driven in-process (it reads
// /workspace/agent/container.json and enters the poll loop), so the guard is
// structural: call + import must both be present in the real entry point.
describe('memory scaffold boot wiring', () => {
  const indexSrc = fs.readFileSync(path.join(import.meta.dir, '..', 'index.ts'), 'utf-8');

  it('scaffolds memory unconditionally in main()', () => {
    expect(indexSrc).toMatch(/\n\s*ensureMemoryScaffold\(\);/);
    expect(indexSrc).not.toContain('usesMemoryScaffold');
  });

  it('imports ensureMemoryScaffold from the seam module', () => {
    expect(indexSrc).toContain("import { ensureMemoryScaffold } from './memory/scaffold.js'");
  });
});
