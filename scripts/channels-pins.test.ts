import { describe, expect, it } from 'vitest';

import { channelsPinProblems, report } from './channels-pins.js';
import { groupPins, scanSkill } from './skill-pins.js';

const SKILL = [
  '# Add chat', // 1
  '', // 2
  '```nc:dep', // 3
  'chat-adapter@0.3.0', // 4
  '```', // 5
  '', // 6
  '```nc:dep manager:bun cwd:container/agent-runner', // 7
  'runner-sdk@2.0.0', // 8
  '```', // 9
  '',
].join('\n');

const pins = groupPins(scanSkill('.claude/skills/add-chat/SKILL.md', SKILL)).pins;

// What channels lists, and what its pnpm-lock.yaml installs (with pnpm's peer suffix).
const channels = (spec: string, installed: string, lockedSpec = spec) => ({
  pkg: { dependencies: { 'chat-adapter': spec, 'runner-sdk': '^1.0.0' } },
  lock: {
    importers: {
      '.': {
        dependencies: {
          'chat-adapter': { specifier: lockedSpec, version: `${installed}(chat@4.41.1)` },
          'runner-sdk': { specifier: '^1.0.0', version: '1.0.0' },
        },
      },
    },
  },
});

describe('channelsPinProblems', () => {
  it('fails when channels installs another version than the skill pins, and names the fix', () => {
    const { pkg, lock } = channels('^0.1.1', '0.1.1');
    const problems = channelsPinProblems(pins, pkg, lock, 'origin/channels');
    expect(problems).toEqual([
      'chat-adapter: origin/channels has "^0.1.1" (lockfile: "^0.1.1" -> 0.1.1), the skills pin 0.3.0 (.claude/skills/add-chat/SKILL.md:4)',
    ]);
    const result = report(problems, 'origin/channels');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('if this change moved a skill pin, open a PR to channels');
    expect(result.message).toContain('the exact pinned version (no ^ or ~)');
  });

  it('fails on a range, even while the lockfile installs the pinned version', () => {
    // pino drifted this way: "^9.6.0" installed 9.6.0 until the lockfile moved to 9.14.0.
    const { pkg, lock } = channels('^0.3.0', '0.3.0');
    expect(channelsPinProblems(pins, pkg, lock, 'origin/channels')).toEqual([
      'chat-adapter: origin/channels has "^0.3.0" (lockfile: "^0.3.0" -> 0.3.0), the skills pin 0.3.0 (.claude/skills/add-chat/SKILL.md:4)',
    ]);
  });

  it('fails when package.json changed but the lockfile was not regenerated', () => {
    // It installs the pinned 0.3.0, but was made from "^0.3.0", not package.json's "0.3.0".
    const { pkg, lock } = channels('0.3.0', '0.3.0', '^0.3.0');
    expect(channelsPinProblems(pins, pkg, lock, 'origin/channels')).toEqual([
      'chat-adapter: origin/channels has "0.3.0" (lockfile: "^0.3.0" -> 0.3.0), the skills pin 0.3.0 (.claude/skills/add-chat/SKILL.md:4)',
    ]);
  });

  it('treats a cwd that resolves to the root as the host package.json', () => {
    const skill = '```nc:dep cwd:./.\nchat-adapter@0.3.0\n```\n';
    const rootPins = groupPins(scanSkill('.claude/skills/add-chat/SKILL.md', skill)).pins;
    expect(rootPins.get('chat-adapter')?.[0].detail).toContain('cwd:./.');
    const { pkg, lock } = channels('^0.1.1', '0.1.1');
    expect(channelsPinProblems(rootPins, pkg, lock, 'origin/channels')).toHaveLength(1);
  });

  it('passes when channels installs the pinned version, ignoring pins for other package.json files', () => {
    // runner-sdk differs, but its pin goes into container/agent-runner, not the host package.json.
    const { pkg, lock } = channels('0.3.0', '0.3.0');
    const problems = channelsPinProblems(pins, pkg, lock, 'origin/channels');
    expect(problems).toEqual([]);
    expect(report(problems, 'origin/channels')).toEqual({
      ok: true,
      message: 'origin/channels package.json matches the skill pins.',
    });
  });
});
