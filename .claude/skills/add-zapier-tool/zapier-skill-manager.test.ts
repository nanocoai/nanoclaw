import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const skillRoot = process.env.ZAPIER_SKILL_DIR ?? join(projectRoot, '.claude/skills/add-zapier-tool');
const manager = join(skillRoot, 'scripts/manage-zapier-skill.sh');
const source = join(skillRoot, 'container-skills/zapier-tools/SKILL.md');

function run(root: string, mode: 'install' | 'remove', groups = ''): void {
  execFileSync('bash', [manager, mode, root, source, groups], { stdio: 'pipe' });
}

function target(root: string, group: string, provider = '.claude-shared'): string {
  return join(root, 'data/v2-sessions', group, provider, 'skills/nanoclaw-zapier-tools/SKILL.md');
}

describe('Zapier per-group runtime skill manager', () => {
  it('installs idempotently for selected groups and removes every owned provider copy', () => {
    const root = mkdtempSync(join(tmpdir(), 'zapier-skill-manager-'));
    run(root, 'install', 'ag-one,ag-two');
    run(root, 'install', 'ag-one,ag-two');
    expect(readFileSync(target(root, 'ag-one'), 'utf8')).toContain('owner: add-zapier-tool');
    expect(readFileSync(target(root, 'ag-two'), 'utf8')).toContain('name: zapier-tools');

    const codexCopy = target(root, 'ag-one', '.agents');
    mkdirSync(dirname(codexCopy), { recursive: true });
    writeFileSync(codexCopy, readFileSync(source, 'utf8'));
    const partialCopy = target(root, 'ag-partial');
    mkdirSync(dirname(partialCopy), { recursive: true });
    writeFileSync(partialCopy, readFileSync(source, 'utf8'));

    run(root, 'remove');
    expect(() => readFileSync(target(root, 'ag-one'))).toThrow();
    expect(() => readFileSync(codexCopy)).toThrow();
    expect(() => readFileSync(partialCopy)).toThrow();
  });

  it('refuses an existing unowned skill and preserves it during removal', () => {
    const root = mkdtempSync(join(tmpdir(), 'zapier-skill-conflict-'));
    const conflict = target(root, 'ag-one');
    mkdirSync(dirname(conflict), { recursive: true });
    writeFileSync(conflict, 'user-owned\n');
    expect(() => run(root, 'install', 'ag-one')).toThrow();
    run(root, 'remove');
    expect(readFileSync(conflict, 'utf8')).toBe('user-owned\n');
  });

  it('rejects a group id that could escape its session directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'zapier-skill-path-'));
    expect(() => run(root, 'install', 'ag-one,../../outside')).toThrow();
    expect(() => readFileSync(join(root, 'outside/SKILL.md'))).toThrow();
  });
});
