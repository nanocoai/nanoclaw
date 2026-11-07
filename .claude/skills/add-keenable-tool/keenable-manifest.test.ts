/**
 * Guards for the Keenable MCP tool skill.
 *
 * `mcp-remote` is a globally installed CLI, so neither an import nor a
 * typecheck can detect its removal. The registration itself is runtime DB
 * state, but the argument shape it is built from lives in SKILL.md, so that
 * half is guarded structurally.
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

const root = repoRoot();

describe('the Keenable MCP bridge is installed in the agent image', () => {
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

describe('the Keenable registration arguments are intact', () => {
  const skillMd = fs.readFileSync(path.join(root, '.claude', 'skills', 'add-keenable-tool', 'SKILL.md'), 'utf8');

  it('registers the hosted MCP endpoint', () => {
    expect(skillMd).toContain('https://api.keenable.ai/mcp');
  });

  it('carries the attribution query parameter that identifies this traffic', () => {
    expect(skillMd).toContain('keenable_title=nanoclaw');
  });

  it('pins the transport the bridge speaks', () => {
    expect(skillMd).toContain('"--transport","http-only"');
  });

  it('keeps the bridge proxy-aware, so it reaches the gateway under egress lockdown', () => {
    expect(skillMd).toContain('--enable-proxy');
  });
});
