import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  discover,
  formatUnavailable,
  missingRegistrySources,
  partitionRegistryAvailability,
  selectCombinedProviders,
  type RegistrySkill,
} from './test-registry-skills.js';

function skill(name: string, copy: string[], extra: Partial<RegistrySkill> = {}): RegistrySkill {
  return {
    skill: name,
    branches: ['providers'],
    bun: false,
    executable: true,
    dir: `.claude/skills/${name}`,
    markdown: ['```nc:copy from-branch:providers', ...copy, '```', ''].join('\n'),
    ...extra,
  };
}

const registry = new Set(['providers:src/providers/codex.ts', 'providers:src/providers/opencode.ts']);
const hasSource = (branch: string, path: string) => registry.has(`${branch}:${path}`);

afterEach(() => vi.restoreAllMocks());

describe('registry availability filter', () => {
  it('names every copy source the registry commit lacks', () => {
    const meta = skill('add-codex', ['src/providers/codex.ts', 'src/provider-contracts/codex.ts -> src/x.ts']);
    expect(missingRegistrySources(meta, hasSource)).toEqual(['providers:src/provider-contracts/codex.ts']);
  });

  it('splits skills into available and unavailable with a WARN line per skipped skill', () => {
    const ok = skill('add-opencode', ['src/providers/opencode.ts']);
    const stale = skill('add-codex', ['src/providers/codex.ts', 'src/provider-contracts/codex.ts']);
    const { available, unavailable } = partitionRegistryAvailability([ok, stale], hasSource);
    expect(available.map((s) => s.skill)).toEqual(['add-opencode']);
    expect(unavailable.map(formatUnavailable)).toEqual([
      'WARN: add-codex unavailable in registry (missing: providers:src/provider-contracts/codex.ts)',
    ]);
  });
});

describe('--combined-providers selection', () => {
  it('fails loudly when trunk carries provider skills but none is available', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const codex = skill('add-codex', ['src/provider-contracts/codex.ts'], { provider: 'codex' });
    const opencode = skill('add-opencode', ['src/provider-contracts/opencode.ts'], { provider: 'opencode' });
    expect(() => selectCombinedProviders([codex, opencode], hasSource)).toThrow(
      /FAIL: trunk carries provider skills \(add-codex, add-opencode\) but none is available/,
    );
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      'WARN: add-codex unavailable in registry (missing: providers:src/provider-contracts/codex.ts)',
      'WARN: add-opencode unavailable in registry (missing: providers:src/provider-contracts/opencode.ts)',
    ]);
  });

  it('keeps the available provider skills and warns about the rest', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const codex = skill('add-codex', ['src/providers/codex.ts'], { provider: 'codex' });
    const stale = skill('add-opencode', ['src/provider-contracts/opencode.ts'], { provider: 'opencode' });
    expect(selectCombinedProviders([codex, stale], hasSource).map((s) => s.provider)).toEqual(['codex']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rejects a provider skill without nanoclaw-provider metadata', () => {
    expect(() => selectCombinedProviders([skill('add-mystery', ['src/providers/codex.ts'])], hasSource)).toThrow(
      /missing nanoclaw-provider metadata: add-mystery/,
    );
  });

  it('selects nothing only when trunk ships no provider skill at all', () => {
    const channel = skill('add-slack', ['src/channels/slack.ts'], { branches: ['channels'] });
    expect(selectCombinedProviders([channel], hasSource)).toEqual([]);
  });
});

describe('self-contained provider discovery', () => {
  it('includes a local payload in the CI matrix and combined-provider selection without a registry branch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-provider-discovery-'));
    try {
      const dir = path.join(root, 'add-local');
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        [
          '---',
          'name: add-local',
          'description: Local provider',
          'metadata:',
          '  nanoclaw-provider: local',
          '  nanoclaw-provider-label: Local',
          '  nanoclaw-provider-hint: Test provider',
          "  nanoclaw-provider-offered: 'false'",
          '  nanoclaw-provider-image: local-required',
          '---',
          '```nc:copy',
          'payload/src/providers/local.ts -> src/providers/local.ts',
          '```',
        ].join('\n'),
      );
      const skills = discover(root);
      expect(skills).toHaveLength(1);
      expect(skills[0]).toMatchObject({ skill: 'add-local', provider: 'local', branches: [], executable: true });
      const lookup = vi.fn(() => false);
      expect(partitionRegistryAvailability(skills, lookup).available).toEqual(skills);
      expect(selectCombinedProviders(skills, lookup)).toEqual(skills);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
