import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'container', 'cli-tools.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`container/cli-tools.json not found from ${__dirname}`);
}

describe('OpenCode CLI and SDK pins', () => {
  const root = repoRoot();
  const tools = JSON.parse(fs.readFileSync(path.join(root, 'container', 'cli-tools.json'), 'utf8')) as Array<{
    name: string;
    version: string;
  }>;
  const runner = JSON.parse(fs.readFileSync(path.join(root, 'container', 'agent-runner', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };

  it('installs opencode-ai from the pinned global CLI manifest', () => {
    const entry = tools.find((tool) => tool.name === 'opencode-ai');
    expect(entry?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keeps the global CLI and agent-runner SDK on the same exact version', () => {
    const cliVersion = tools.find((tool) => tool.name === 'opencode-ai')?.version;
    expect(runner.dependencies?.['@opencode-ai/sdk']).toBe(cliVersion);
  });
});
