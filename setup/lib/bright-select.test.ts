import { afterEach, describe, expect, it, vi } from 'vitest';

import { brightSelect } from './bright-select.js';

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

afterEach(() => vi.restoreAllMocks());

describe('brightSelect abort', () => {
  it('draws the aborted label as the last frame', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const controller = new AbortController();
    const answer = brightSelect({
      message: 'Keep waiting?',
      options: [
        { value: 'wait', label: 'Keep waiting' },
        { value: 'skip', label: 'Skip' },
      ],
      signal: controller.signal,
      abortedLabel: (reason) => `Done: ${String(reason)}`,
    });
    await new Promise((r) => setTimeout(r, 100));
    controller.abort('replied');
    expect(typeof (await answer)).toBe('symbol');
    const out = plain(writes.join(''));
    const last = out.slice(out.lastIndexOf('Keep waiting?'));
    expect(last).toContain('Done: replied');
    expect(last).not.toContain('Skip');
  });

  it('does not open when already aborted', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const controller = new AbortController();
    controller.abort();
    const answer = await brightSelect({ message: 'Q?', options: [{ value: 1 }], signal: controller.signal });
    expect(typeof answer).toBe('symbol');
    expect(write).not.toHaveBeenCalled();
  });
});
