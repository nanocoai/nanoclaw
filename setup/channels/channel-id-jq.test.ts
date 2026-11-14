import { spawnSync } from 'child_process';
import fs from 'fs';

import { describe, expect, it } from 'vitest';

import { parseDirectives } from '../../scripts/skill-directives.js';

/**
 * Channel skills turn an API reply into an id with a jq filter. A reply without
 * the id (Slack's missing_scope, a Discord error) must fail the step: a filter
 * that builds "slack:" + null prints "slack:" and exits 0. Each case runs the
 * step's real filter under bash, fed the reply its curl would get.
 */
const hasJq = spawnSync('sh', ['-c', 'command -v jq'], { stdio: 'ignore' }).status === 0;

function filterFor(skill: string, capture: string): string {
  const md = fs.readFileSync(`.claude/skills/${skill}/SKILL.md`, 'utf8');
  const run = parseDirectives(md).find((d) => d.kind === 'run' && d.attrs.capture === capture);
  const cmd = run?.body.join('\n') ?? '';
  const at = cmd.indexOf('| jq ');
  expect(at).toBeGreaterThan(0);
  return cmd.slice(at + 2);
}

function feed(filter: string, reply: string): { status: number | null; stdout: string } {
  const r = spawnSync('bash', ['-c', `printf '%s' "$REPLY" | ${filter}`], {
    env: { ...process.env, REPLY: reply },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout.trim() };
}

describe.skipIf(!hasJq)('channel id filters', () => {
  it.each([
    {
      skill: 'add-slack',
      capture: 'connected_as',
      good: '{"ok":true,"user":"nanoclaw","team":"Acme"}',
      want: '@nanoclaw in Acme',
      bad: '{"ok":false,"error":"invalid_auth"}',
    },
    {
      skill: 'add-slack',
      capture: 'platform_id',
      good: '{"ok":true,"channel":{"id":"D0ABC123"}}',
      want: 'slack:D0ABC123',
      bad: '{"ok":false,"error":"missing_scope","needed":"im:write"}',
    },
    {
      skill: 'add-discord',
      capture: 'platform_id',
      good: '{"id":"1234567890","type":1}',
      want: 'discord:@me:1234567890',
      bad: '{"message":"Cannot send messages to this user","code":50007}',
    },
  ])('$skill $capture: prints the value, and fails on a reply without it', ({ skill, capture, good, want, bad }) => {
    const filter = filterFor(skill, capture);
    expect(feed(filter, good)).toEqual({ status: 0, stdout: want });
    const failed = feed(filter, bad);
    expect(failed.status).not.toBe(0);
    expect(failed.stdout).toBe('');
  });
});
