import { Readable } from 'stream';
import { describe, expect, it } from 'vitest';

import { readUtf8StdinBounded, resolveCreateSpecStdin } from './stdin.js';

describe('agent create-spec stdin transport', () => {
  it('accepts a create spec larger than the usual single-argv limit', async () => {
    const payload = JSON.stringify({ version: 2, name: 'x', padding: 'a'.repeat(256 * 1024) });
    await expect(readUtf8StdinBounded(Readable.from([payload]))).resolves.toBe(payload);

    const args: Record<string, unknown> = { 'spec-stdin': true };
    await resolveCreateSpecStdin('groups-create', args, Readable.from([payload]));
    expect(args).toEqual({ spec: payload });
  });

  it('rejects a body beyond the configured bound', async () => {
    await expect(readUtf8StdinBounded(Readable.from(['abcdef']), 5)).rejects.toThrow(/exceeds 5 bytes/);
  });

  it('rejects the stdin flag on other commands or alongside argv JSON', async () => {
    await expect(
      resolveCreateSpecStdin('templates-get', { 'spec-stdin': true }, Readable.from(['{}'])),
    ).rejects.toThrow(/only valid.*groups create/);
    await expect(
      resolveCreateSpecStdin('groups-create', { 'spec-stdin': true, spec: '{}' }, Readable.from(['{}'])),
    ).rejects.toThrow(/cannot be combined/);
  });
});
