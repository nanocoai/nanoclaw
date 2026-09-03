import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'bun:test';

import { MAX_STDIN_JSON_BYTES, readStdinJsonArgs, type StdinJsonStream } from './stdin-json.js';

async function* stream(...chunks: Array<string | Uint8Array>): StdinJsonStream {
  for (const chunk of chunks) yield chunk;
}

describe('container CLI bounded stdin JSON', () => {
  it('merges structured stdin with argv-derived args', async () => {
    const result = await readStdinJsonArgs(stream('{"nested":{"enabled":true}}'), {
      'argv-value': 'from-argv',
    });

    expect(result).toEqual({
      'argv-value': 'from-argv',
      nested: { enabled: true },
    });
  });

  it('rejects input over 64 KiB', async () => {
    const envelopeBytes = Buffer.byteLength('{"payload":""}', 'utf8');
    const source = `{"payload":"${'a'.repeat(MAX_STDIN_JSON_BYTES - envelopeBytes + 1)}"}`;

    await expect(readStdinJsonArgs(stream(source), {})).rejects.toThrow(
      `--stdin-json input exceeds ${MAX_STDIN_JSON_BYTES} bytes`,
    );
  });

  it.each(['', '[]', 'null', '{"broken":'])('rejects invalid input: %s', async (source) => {
    await expect(readStdinJsonArgs(stream(source), {})).rejects.toThrow();
  });

  it('rejects normalized duplicate keys', async () => {
    await expect(
      readStdinJsonArgs(stream('{"group_id":"stdin-value"}'), {
        'group-id': 'argv-value',
      }),
    ).rejects.toThrow('--stdin-json key "group_id" conflicts with argv key "group-id" after CLI key normalization');
  });

  it('rejects __proto__ input', async () => {
    await expect(readStdinJsonArgs(stream('{"__proto__":{"polluted":true}}'), {})).rejects.toThrow(
      '--stdin-json key "__proto__" is not allowed',
    );
  });

  it('recognizes --stdin-json before opening the session databases', () => {
    const result = spawnSync(process.execPath, ['src/cli/ncl.ts', 'groups', 'list', '--stdin-json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: '{"broken":',
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('ncl: --stdin-json input is not valid JSON\n');
  });
});
