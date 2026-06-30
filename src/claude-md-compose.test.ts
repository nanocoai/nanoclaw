import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { composeGroupClaudeMd } from './claude-md-compose.js';
import { GROUPS_DIR } from './config.js';
import type { AgentGroup } from './types.js';

const cleanupPaths: string[] = [];

function remember(pathToClean: string): string {
  cleanupPaths.push(pathToClean);
  return pathToClean;
}

function tmpDir(): string {
  return remember(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-claude-compose-')));
}

afterEach(() => {
  for (const p of cleanupPaths.splice(0)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
});

describe('composeGroupClaudeMd', () => {
  it('does not follow a container-controlled .claude-fragments symlink', () => {
    const folder = `test-symlink-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const groupDir = remember(path.join(GROUPS_DIR, folder));
    const outside = tmpDir();
    fs.mkdirSync(groupDir, { recursive: true });

    const victim = path.join(outside, 'mount-allowlist.json');
    fs.writeFileSync(victim, 'keep me');
    fs.symlinkSync(outside, path.join(groupDir, '.claude-fragments'), 'dir');

    const group: AgentGroup = {
      id: `ag-${folder}`,
      name: 'Symlink Test',
      folder,
      agent_provider: null,
      created_at: new Date().toISOString(),
    };

    expect(() => composeGroupClaudeMd(group)).toThrow(/CLAUDE fragment directory.*not a symlink/);
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep me');
  });
});
