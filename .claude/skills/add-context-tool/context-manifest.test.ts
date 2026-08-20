import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

function repoRoot(): string {
  let directory = __dirname;
  for (let depth = 0; depth < 8; depth++) {
    if (fs.existsSync(path.join(directory, 'container', 'cli-tools.json'))) return directory;
    directory = path.dirname(directory);
  }
  throw new Error('container/cli-tools.json not found while walking up from ' + __dirname);
}

describe('the Context.dev MCP bridge is installed in the agent image', () => {
  const root = repoRoot();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'container', 'cli-tools.json'), 'utf8')) as Array<{
    name: string;
    version: string;
  }>;

  it('appears in the CLI manifest', () => {
    expect(manifest.map((entry) => entry.name)).toContain('mcp-remote');
  });

  it('is pinned to an exact version', () => {
    const bridge = manifest.find((entry) => entry.name === 'mcp-remote');
    expect(bridge?.version ?? '').toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  });
});
