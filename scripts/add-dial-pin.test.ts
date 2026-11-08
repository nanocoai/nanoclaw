import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseDirectives } from './skill-directives.js';

const realJq = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();
const hasJq = realJq !== '';

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
      // Records the umask each jq runs under; the last run writes the new file.
      const jq = `#!/bin/sh\numask > '${dir}/umask'\nexec '${realJq}' "$@"\n`;
      fs.writeFileSync(path.join(bin, 'jq'), jq, { mode: 0o755 });
      const r = spawnSync('bash', ['-c', cmd], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_DATA_HOME: dir },
        encoding: 'utf8',
      });
      expect(r.stdout.trim()).toBe('default sender pinned to +15551234567');
      expect(fs.readFileSync(path.join(dir, 'umask'), 'utf8').trim()).toBe('0077');
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
