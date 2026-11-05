import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

// The pin rewrites the Dial auth file, which holds the account's token, so
// the rewrite must never sit on disk readable by other users.
describe.skipIf(!hasJq)('Dial default-sender pin', () => {
  it('writes the new auth file private from the start', () => {
    const md = fs.readFileSync('.claude/skills/add-dial/SKILL.md', 'utf8');
    const pin = parseDirectives(md).find(
      (d) => d.kind === 'run' && d.body.join('\n').includes('default sender pinned'),
    );
    const cmd = (pin?.body.join('\n') ?? '')
      .replaceAll('{{dial_ua}}', 'nanoclaw/test')
      .replaceAll('{{platform_id}}', '+15551234567');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dial-pin-'));
    try {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(path.join(dir, 'dial'), { recursive: true });
      fs.mkdirSync(bin);
      const auth = path.join(dir, 'dial', 'auth.v1.json');
      fs.writeFileSync(auth, '{"token":"secret"}', { mode: 0o600 });
      fs.writeFileSync(
        path.join(bin, 'dial'),
        `#!/bin/sh\necho '{"numbers":[{"number":"+15551234567","id":"num_1"}]}'\n`,
        { mode: 0o755 },
      );
      // Records the rewrite's mode just before it replaces the auth file.
      const mv = `#!/bin/sh\nls -l "$2" | cut -c1-10 > '${dir}/mode'\nexec /bin/mv "$@"\n`;
      fs.writeFileSync(path.join(bin, 'mv'), mv, { mode: 0o755 });
      const r = spawnSync('bash', ['-c', cmd], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_DATA_HOME: dir },
        encoding: 'utf8',
      });
      expect(r.stdout.trim()).toBe('default sender pinned to +15551234567');
      expect(fs.readFileSync(path.join(dir, 'mode'), 'utf8').trim()).toBe('-rw-------');
      expect(JSON.parse(fs.readFileSync(auth, 'utf8'))).toEqual({
        token: 'secret',
        phoneNumber: '+15551234567',
        phoneNumberId: 'num_1',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
