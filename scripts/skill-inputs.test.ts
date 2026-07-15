import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inputsFromEnv } from './skill-inputs.js';
import { applySkill, fullyApplied } from './skill-apply.js';

describe('inputsFromEnv (docs/skill-engine-seam.md §6)', () => {
  it('maps NC_INPUT_<VAR> env keys onto prompt vars, ignoring unset and unrelated keys', () => {
    const md = [
      '```nc:prompt bot_token secret',
      'Paste the token.',
      '```',
      '```nc:prompt owner_handle',
      'Your handle?',
      '```',
    ].join('\n');
    const inputs = inputsFromEnv(md, {
      NC_INPUT_BOT_TOKEN: 'xoxb-fake',
      NC_INPUT_UNRELATED: 'ignored', // no matching prompt
      PATH: '/usr/bin', // not NC_INPUT_-prefixed
      // NC_INPUT_OWNER_HANDLE deliberately unset → omitted, not ''
    });
    expect(inputs).toEqual({ bot_token: 'xoxb-fake' });
  });

  it('errors on an uppercase collision instead of silently merging', () => {
    const md = [
      '```nc:prompt bot_token',
      'Token?',
      '```',
      '```nc:prompt Bot_Token',
      'Token again?',
      '```',
    ].join('\n');
    expect(() => inputsFromEnv(md, {})).toThrow(/NC_INPUT_BOT_TOKEN/);
  });

  // The round-trip proof for one real skill: env → inputsFromEnv → applySkill
  // goes fully green for add-slack (webhook leg) with stubbed exec — the exact
  // pipeline-consumer path the seam doc's §6 contract describes.
  it('round-trips the env convention through a full programmatic apply of add-slack', async () => {
    const skillDir = join(process.cwd(), '.claude/skills/add-slack');
    const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    const inputs = inputsFromEnv(md, {
      NC_INPUT_CONNECTION: 'webhook',
      NC_INPUT_BOT_TOKEN: 'xoxb-fake-token',
      NC_INPUT_SIGNING_SECRET: '0123456789abcdef',
      NC_INPUT_OWNER_HANDLE: 'U12345678',
    });
    expect(inputs).toEqual({
      connection: 'webhook',
      bot_token: 'xoxb-fake-token',
      signing_secret: '0123456789abcdef',
      owner_handle: 'U12345678',
    });

    const root = mkdtempSync(join(tmpdir(), 'skill-inputs-'));
    try {
      mkdirSync(join(root, 'src/channels'), { recursive: true });
      writeFileSync(join(root, 'src/channels/index.ts'), '// barrel\n');
      writeFileSync(join(root, '.env'), '');
      writeFileSync(join(root, 'package.json'), '{"name":"scratch"}\n');

      const res = await applySkill(skillDir, root, {
        inputs,
        exec: (c) => {
          if (c.includes('auth.test')) return '@nano in Acme';
          if (c.includes('conversations.open')) return 'slack:D0FAKE';
        },
        resolveRemote: () => 'origin',
      });
      expect(res.deferred).toEqual([]);
      expect(res.agentTasks).toEqual([]);
      expect(fullyApplied(res)).toBe(true);
      expect(res.vars.platform_id).toBe('slack:D0FAKE');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
