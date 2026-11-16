import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendLines,
  appendProblems,
  copySources,
  dependencyProblems,
  discover,
  guardedDirectives,
  formatUnavailable,
  matrixSkills,
  missingRegistrySources,
  partitionRegistryAvailability,
  selectCombinedChannels,
  selectCombinedProviders,
  type RegistrySkill,
} from './test-registry-skills.js';

function skill(name: string, copy: string[], extra: Partial<RegistrySkill> = {}): RegistrySkill {
  return {
    skill: name,
    branches: ['providers'],
    channel: false,
    bun: false,
    executable: true,
    dir: `.claude/skills/${name}`,
    markdown: ['```nc:copy from-branch:providers', ...copy, '```', ''].join('\n'),
    ...extra,
  };
}

function channelSkill(name: string, copy: string[]): RegistrySkill {
  const markdown = ['```nc:copy from-branch:channels', ...copy, '```', ''].join('\n');
  return skill(name, copy, { branches: ['channels'], channel: true, markdown });
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

describe('--combined-channels selection', () => {
  const channels = new Set(['channels:src/channels/slack.ts']);
  const hasChannel = (branch: string, path: string) => channels.has(`${branch}:${path}`);

  it('fails loudly when trunk carries channel skills but none can be applied', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gchat = channelSkill('add-gchat', ['src/channels/gchat.ts']);
    expect(() => selectCombinedChannels([gchat], hasChannel)).toThrow(
      /FAIL: trunk carries channel skills \(add-gchat\) but none is available/,
    );
    expect(warn).toHaveBeenCalledWith(
      'WARN: add-gchat unavailable in registry (missing: channels:src/channels/gchat.ts)',
    );
  });

  it('combines channel payloads and branch-only channel companions, never providers', () => {
    const slack = channelSkill('add-slack', ['src/channels/slack.ts']);
    const flow = skill('slack-agent-flow', [], { branches: ['channels'] });
    const local = skill('add-local', [], { branches: [], channel: true });
    const codex = skill('add-codex', [], { branches: [], provider: 'codex' });
    expect(selectCombinedChannels([codex, local, slack, flow], hasChannel).map((s) => s.skill)).toEqual([
      'add-local',
      'add-slack',
      'slack-agent-flow',
    ]);
  });
});

describe('copy sources', () => {
  it('names the registry blob or the skill payload file behind every unguarded copy destination', () => {
    const meta = skill('add-gchat', [], {
      markdown: [
        '```nc:copy from-branch:channels',
        'src/channels/gchat.ts',
        '```',
        '```nc:copy',
        'payload/src/channels/gchat-registration.test.ts -> src/channels/gchat-registration.test.ts',
        '```',
        '```nc:copy when:backend=hosted',
        'payload/src/channels/gchat-hosted.ts -> src/channels/gchat-hosted.ts',
        '```',
      ].join('\n'),
    });
    expect(copySources(meta)).toEqual([
      { dest: 'src/channels/gchat.ts', branch: 'channels', source: 'src/channels/gchat.ts' },
      { dest: 'src/channels/gchat-registration.test.ts', source: 'payload/src/channels/gchat-registration.test.ts' },
    ]);
  });

  it('leaves out, and names, barrel imports that depend on install answers', () => {
    const meta = skill('add-imessage', [], {
      markdown: [
        '```nc:append to:src/channels/index.ts',
        "import './imessage.js';",
        '```',
        '```nc:append to:src/channels/index.ts when:backend=hosted',
        "import './imessage-hosted.js';",
        '```',
      ].join('\n'),
    });
    expect(appendLines(meta)).toEqual([{ to: 'src/channels/index.ts', line: "import './imessage.js';" }]);
    // Its guard hangs on install answers the harness does not reproduce, so the job names it instead.
    expect(guardedDirectives(meta)).toEqual([4]);
  });

  it('names each unguarded append line its file does not hold exactly once, barrel or not', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'append-lines-'));
    try {
      fs.mkdirSync(path.join(root, 'src/channels'), { recursive: true });
      fs.mkdirSync(path.join(root, 'setup'));
      fs.writeFileSync(path.join(root, 'src/channels/index.ts'), "import './telegram.js';\nimport './telegram.js';\n");
      fs.writeFileSync(
        path.join(root, 'setup/index.ts'),
        '  // >>> nanoclaw:setup-steps\n  // <<< nanoclaw:setup-steps\n',
      );
      const meta = skill('add-telegram', [], {
        channel: true,
        markdown: [
          '```nc:append to:src/channels/index.ts',
          "import './telegram.js';",
          '```',
          '```nc:append to:setup/index.ts at:nanoclaw:setup-steps',
          "'pair-telegram': () => import('./pair-telegram.js'),",
          '```',
        ].join('\n'),
      });
      expect(appendProblems(root, [meta])).toEqual([
        `add-telegram: src/channels/index.ts must hold "import './telegram.js';" exactly once`,
        `add-telegram: setup/index.ts must hold "'pair-telegram': () => import('./pair-telegram.js')," exactly once`,
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('dependency pins after a refresh', () => {
  it('names each unguarded nc:dep pin its package.json does not hold exactly', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-pins-'));
    try {
      const pkg = { dependencies: { qrcode: '1.5.4', pino: '^9.6.0' }, devDependencies: { qrcode: '1.5.3' } };
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
      const meta = skill('add-whatsapp', [], {
        markdown: [
          '```nc:dep',
          'qrcode@1.5.4',
          'pino@9.6.0',
          '@whiskeysockets/baileys@7.0.0-rc14',
          '```',
          '```nc:dep when:backend=hosted',
          'spectrum-ts@11.0.0',
          '```',
        ].join('\n'),
      });
      expect(dependencyProblems(root, meta)).toEqual([
        'add-whatsapp: package.json lacks qrcode@1.5.4',
        'add-whatsapp: package.json lacks pino@9.6.0',
        'add-whatsapp: package.json lacks @whiskeysockets/baileys@7.0.0-rc14',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function writeSkill(root: string, name: string, lines: string[]): void {
  fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, name, 'SKILL.md'), lines.join('\n'));
}

describe('payload discovery', () => {
  it('keeps a payload-only channel skill and a branch-backed slack-agent-flow', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-discovery-'));
    try {
      writeSkill(root, 'add-local', ['```nc:copy', 'payload/src/channels/local.ts -> src/channels/local.ts', '```']);
      writeSkill(root, 'slack-agent-flow', ['```nc:copy from-branch:channels', 'src/env-file.ts', '```']);
      writeSkill(root, 'customize', ['```nc:copy from-branch:channels', 'src/channels/x.ts', '```']);
      const warn = vi.fn();
      const skills = discover(root, warn);
      expect(skills).toMatchObject([
        { skill: 'add-local', channel: true, branches: [], executable: true },
        { skill: 'slack-agent-flow', channel: false, branches: ['channels'], executable: true },
      ]);
      expect(warn).not.toHaveBeenCalled();
      // It needs the Slack adapter installed first, so it is left to the combined tree.
      expect(matrixSkills(skills).map((s) => s.skill)).toEqual(['add-local']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('warns about a payload-only skill that is neither a channel nor a provider', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-discovery-'));
    try {
      writeSkill(root, 'add-gateway', [
        '```nc:copy',
        'payload/src/gateway-providers/gw.ts -> src/gateway-providers/gw.ts',
        '```',
      ]);
      writeSkill(root, 'add-docs-only', ['# no directives']);
      const warn = vi.fn();
      expect(discover(root, warn)).toEqual([]);
      expect(warn.mock.calls).toEqual([
        ['WARN: add-gateway skipped: its payload is neither a channel nor a provider, so no registry job tests it'],
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
      expect(skills[0]).toMatchObject({
        skill: 'add-local',
        provider: 'local',
        channel: false,
        branches: [],
        executable: true,
      });
      const lookup = vi.fn(() => false);
      expect(partitionRegistryAvailability(skills, lookup).available).toEqual(skills);
      expect(selectCombinedProviders(skills, lookup)).toEqual(skills);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
