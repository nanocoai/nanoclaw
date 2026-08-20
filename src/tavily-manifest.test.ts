/**
 * Dependency guard for the Tavily remote MCP bridge.
 *
 * `mcp-remote` is a globally installed CLI, so neither an import nor a
 * typecheck can detect its removal. Per-group MCP registration is runtime DB
 * state and is verified by the install skill's smoke test.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'container', 'cli-tools.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('container/cli-tools.json not found while walking up from ' + __dirname);
}

describe('the Tavily MCP bridge is installed in the agent image', () => {
  const root = repoRoot();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'container', 'cli-tools.json'), 'utf8')) as Array<{
    name: string;
    version: string;
  }>;

  it('appears in the CLI manifest', () => {
    expect(manifest.map((entry) => entry.name)).toContain('mcp-remote');
  });

  it('is pinned to an exact version, so the supply-chain policy still applies', () => {
    const bridge = manifest.find((entry) => entry.name === 'mcp-remote');
    expect(bridge?.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  });
});

describe('the Tavily MCP registration arguments are correctly configured', () => {
  const root = repoRoot();
  const skillMd = fs.readFileSync(path.join(root, '.claude', 'skills', 'add-tavily-tool', 'SKILL.md'), 'utf8');

  it('contains the keyless authorization header', () => {
    expect(skillMd).toContain('X-Tavily-Access-Mode:keyless');
  });

  it('contains the client-name header', () => {
    expect(skillMd).toContain('X-Client-Name:nanoclaw');
  });

  it('filters out all three restricted tools (crawl, map, research)', () => {
    expect(skillMd).toContain('--ignore-tool');
    expect(skillMd).toContain('tavily_crawl');
    expect(skillMd).toContain('tavily_map');
    expect(skillMd).toContain('tavily_research');
  });
});

describe('the Phase 5 upgrade block is correctly configured', () => {
  const root = repoRoot();
  const upgradeInstructions = fs.readFileSync(
    path.join(root, '.claude', 'skills', 'add-tavily-tool', 'upgrade-instructions.md'),
    'utf8',
  );

  it('contains the start and end markers for idempotent replacement', () => {
    expect(upgradeInstructions).toContain('<!-- tavily-upgrade:start -->');
    expect(upgradeInstructions).toContain('<!-- tavily-upgrade:end -->');
  });

  it('contains the dashboard URL placeholder', () => {
    expect(upgradeInstructions).toContain('{{ONECLI_DASHBOARD_URL}}');
  });

  it('specifies the correct deeplink path for the OneCLI secrets creation', () => {
    expect(upgradeInstructions).toContain('/connections/secrets?create=generic&host=mcp.tavily.com');
  });
});
