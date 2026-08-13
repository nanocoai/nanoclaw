import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// --- Mocks ---

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let groupsDir = '';
vi.mock('./config.js', () => ({
  get GROUPS_DIR() {
    return groupsDir;
  },
}));

const mockGetContainerConfig = vi.fn();
vi.mock('./db/container-configs.js', () => ({
  getContainerConfig: (...args: unknown[]) => mockGetContainerConfig(args[0] as string),
}));

import { composeGroupClaudeMd } from './claude-md-compose.js';
import type { AgentGroup } from './types.js';

// Minimal config row — only the fields compose reads.
function configRow(skills: string) {
  return { skills, mcp_servers: '{}', cli_scope: 'group' };
}

const group = { id: 'g1', folder: 'g1' } as unknown as AgentGroup;

describe('composeGroupClaudeMd skill-fragment selection', () => {
  let tmp = '';
  let prevCwd = '';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-test-'));
    // Two instruction-shipping skills under the cwd-relative skills dir.
    for (const name of ['a', 'b']) {
      const dir = path.join(tmp, 'container', 'skills', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'instructions.md'), `# ${name}\n`);
    }
    groupsDir = path.join(tmp, 'groups');
    fs.mkdirSync(groupsDir, { recursive: true });
    prevCwd = process.cwd();
    process.chdir(tmp);
    mockGetContainerConfig.mockReset();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function composedImports(): string[] {
    return fs
      .readFileSync(path.join(groupsDir, 'g1', 'CLAUDE.md'), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('@'));
  }

  // Fragments are symlinks to dangling container paths, so existsSync (which
  // follows the link) is useless here — check the link itself with lstat.
  function fragmentExists(name: string): boolean {
    try {
      fs.lstatSync(path.join(groupsDir, 'g1', '.claude-fragments', name));
      return true;
    } catch {
      return false;
    }
  }

  it('imports only selected skills', () => {
    mockGetContainerConfig.mockReturnValue(configRow('["a"]'));
    composeGroupClaudeMd(group);
    const imports = composedImports();
    expect(imports).toContain('@./.claude-fragments/skill-a.md');
    expect(imports).not.toContain('@./.claude-fragments/skill-b.md');
    // Fragment symlink reconciliation matches the imports.
    expect(fragmentExists('skill-a.md')).toBe(true);
    expect(fragmentExists('skill-b.md')).toBe(false);
  });

  it("imports all instruction-shipping skills when skills is 'all'", () => {
    mockGetContainerConfig.mockReturnValue(configRow('"all"'));
    composeGroupClaudeMd(group);
    const imports = composedImports();
    expect(imports).toContain('@./.claude-fragments/skill-a.md');
    expect(imports).toContain('@./.claude-fragments/skill-b.md');
  });

  it("defaults to 'all' when there is no config row", () => {
    mockGetContainerConfig.mockReturnValue(undefined);
    composeGroupClaudeMd(group);
    const imports = composedImports();
    expect(imports).toContain('@./.claude-fragments/skill-a.md');
    expect(imports).toContain('@./.claude-fragments/skill-b.md');
  });

  it('prunes a previously-imported skill fragment when deselected', () => {
    mockGetContainerConfig.mockReturnValue(configRow('"all"'));
    composeGroupClaudeMd(group);
    expect(fragmentExists('skill-b.md')).toBe(true);

    mockGetContainerConfig.mockReturnValue(configRow('["a"]'));
    composeGroupClaudeMd(group);
    expect(fragmentExists('skill-b.md')).toBe(false);
    expect(composedImports()).not.toContain('@./.claude-fragments/skill-b.md');
  });
});
