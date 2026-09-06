import { afterEach, describe, expect, it, vi } from 'vitest';

import {
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
