import fs from 'fs';
import os from 'os';
import path from 'path';

import { expect, it, vi } from 'vitest';

vi.mock('./claude-handoff.js', () => ({ offerClaudeOnFailure: vi.fn() }));
vi.mock('./diagnostics.js', () => ({ emit: vi.fn() }));
import { spawnQuiet } from './runner.js';

const token = ['ghp', 'T3stT0kenQ9wErTy5uIoP1aSdFgH2jKlZx8C'].join('_');

async function rawLogOf(script: string, env: Record<string, string> = {}): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-log-'));
  const rawLog = path.join(dir, '01-step.log');
  await spawnQuiet('bash', ['-c', script], rawLog, env);
  const log = fs.readFileSync(rawLog, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return log.slice(log.indexOf('\n\n') + 2); // drop the header, which quotes the script
}

it('keeps secrets out of a raw step log, even when one arrives split across chunks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-log-'));
  const rawLog = path.join(dir, '01-step.log');
  const [head, tail] = [token.slice(0, 10), token.slice(10)];
  const script = [
    'echo "x-api-key: opaqueTESTVALUE"',
    'printf %s "$HEAD"',
    'sleep 0.2',
    'printf "%s\\n" "$TAIL"',
    'echo "$HEAD$TAIL" >&2',
    'printf "no newline at end"',
  ].join('; ');

  const res = await spawnQuiet('bash', ['-c', script, '--', `--token=${token}`], rawLog, { HEAD: head, TAIL: tail });

  expect(res.ok).toBe(true);
  // Read at once: setup may exit right after a step, so the log must be complete on resolve.
  const log = fs.readFileSync(rawLog, 'utf8');
  expect(log).not.toContain(token);
  expect(log).not.toContain(tail);
  expect(log).not.toContain('opaqueTESTVALUE');
  expect(log).toContain('x-api-key: [REDACTED]');
  expect(log).toContain('no newline at end');
  fs.rmSync(dir, { recursive: true, force: true });
});

it('masks a PEM body printed one line at a time', async () => {
  const body = `TESTKEY${'A'.repeat(40)}`;
  const log = await rawLogOf(
    'echo "-----BEGIN PRIVATE KEY-----"; sleep 0.1; echo "$BODY"; sleep 0.1; echo "-----END PRIVATE KEY-----"; echo done',
    { BODY: body },
  );
  expect(log).not.toContain(body);
  expect(log).toContain('done');
});

it('keeps a flag and its value together on a very long line', async () => {
  const log = await rawLogOf(
    // The burst ends exactly 1 MiB in, right after the flag.
    'head -c 1048567 /dev/zero | tr "\\0" x; printf " --token "; sleep 0.2; printf "opaqueTESTVALUE\\n"',
  );
  expect(log).not.toContain('opaqueTESTVALUE');
});

it('keeps unterminated stdout and stderr tails apart', async () => {
  const log = await rawLogOf('printf "TOKEN="; printf "ECONNREFUSED" >&2');
  expect(log).toContain('ECONNREFUSED');
});
