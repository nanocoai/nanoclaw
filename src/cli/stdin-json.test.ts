import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { parseArgv } from './parse-argv.js';
import { MAX_STDIN_JSON_BYTES, readStdinJsonArgs, type StdinJsonStream } from './stdin-json.js';

async function* stream(...chunks: Array<string | Uint8Array>): StdinJsonStream {
  for (const chunk of chunks) yield chunk;
}

describe('bounded stdin JSON', () => {
  it('merges one chunked JSON object into argv args', async () => {
    const result = await readStdinJsonArgs(stream('{"source":"stdin",', Buffer.from('"nested":{"enabled":true}}')), {
      name: 'example',
    });

    expect(result).toEqual({
      name: 'example',
      source: 'stdin',
      nested: { enabled: true },
    });
  });

  it('accepts an object whose UTF-8 representation is exactly 64 KiB', async () => {
    const envelopeBytes = Buffer.byteLength('{"payload":""}', 'utf8');
    const source = `{"payload":"${'a'.repeat(MAX_STDIN_JSON_BYTES - envelopeBytes)}"}`;
    expect(Buffer.byteLength(source, 'utf8')).toBe(MAX_STDIN_JSON_BYTES);

    const result = await readStdinJsonArgs(stream(source), {});

    expect((result.payload as string).length).toBe(MAX_STDIN_JSON_BYTES - envelopeBytes);
  });

  it('rejects input one byte over the 64 KiB limit', async () => {
    const envelopeBytes = Buffer.byteLength('{"payload":""}', 'utf8');
    const source = `{"payload":"${'a'.repeat(MAX_STDIN_JSON_BYTES - envelopeBytes + 1)}"}`;

    await expect(readStdinJsonArgs(stream(source), {})).rejects.toThrow(
      `--stdin-json input exceeds ${MAX_STDIN_JSON_BYTES} bytes`,
    );
  });

  it('measures multibyte input as UTF-8 bytes across chunk boundaries', async () => {
    const source = Buffer.from('{"value":"שלום"}', 'utf8');
    const result = await readStdinJsonArgs(stream(source.subarray(0, 12), source.subarray(12)), {});

    expect(result).toEqual({ value: 'שלום' });
  });

  it.each(['', '   \n\t'])('rejects empty input %#', async (source) => {
    await expect(readStdinJsonArgs(stream(source), {})).rejects.toThrow('--stdin-json input is empty');
  });

  it('rejects malformed JSON', async () => {
    await expect(readStdinJsonArgs(stream('{"broken":'), {})).rejects.toThrow('--stdin-json input is not valid JSON');
  });

  it.each(['null', '[]', '"text"', '42', 'true'])('rejects a non-object JSON value: %s', async (source) => {
    await expect(readStdinJsonArgs(stream(source), {})).rejects.toThrow('--stdin-json input must be one JSON object');
  });

  it('rejects a key also supplied on argv', async () => {
    await expect(readStdinJsonArgs(stream('{"subject":"stdin-value"}'), { subject: 'argv-value' })).rejects.toThrow(
      '--stdin-json key "subject" is also supplied on argv',
    );
  });

  it('rejects a stdin key that aliases a hyphenated argv key after CLI normalization', async () => {
    await expect(
      readStdinJsonArgs(stream('{"group_id":"stdin-value"}'), {
        'group-id': 'argv-value',
      }),
    ).rejects.toThrow('--stdin-json key "group_id" conflicts with argv key "group-id" after CLI key normalization');
  });

  it('rejects two stdin keys that alias each other after CLI normalization', async () => {
    await expect(readStdinJsonArgs(stream('{"group-id":"first","group_id":"second"}'), {})).rejects.toThrow(
      '--stdin-json keys "group-id" and "group_id" conflict after CLI key normalization',
    );
  });

  it('rejects __proto__ before downstream argument normalization', async () => {
    await expect(readStdinJsonArgs(stream('{"__proto__":{"id":"task-123"}}'), {})).rejects.toThrow(
      '--stdin-json key "__proto__" is not allowed',
    );
  });
});

describe('host CLI flags', () => {
  it('keeps --json as output mode while excluding --stdin-json from request args', () => {
    expect(parseArgv(['groups', 'update', '--stdin-json', '--json', '--force'])).toEqual({
      command: 'groups-update',
      args: { force: true },
      json: true,
      stdinJson: true,
    });
  });

  it('reports malformed stdin as an input error, not an unexpected failure', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli/client.ts', 'groups', 'list', '--stdin-json'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        input: '{"broken":',
      },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('ncl: --stdin-json input is not valid JSON\n');
  });
});
