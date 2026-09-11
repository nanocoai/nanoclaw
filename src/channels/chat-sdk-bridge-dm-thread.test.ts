import { describe, expect, it } from 'vitest';

import { normalizeDmThreadId } from './chat-sdk-bridge.js';

// Agent-view DMs: top-level messages arrive with an empty threadTs
// (`…:<channel>:`) — the normalization roots the conversation thread on the
// message's own ts so status/replies/titles have a thread to land in.
describe('normalizeDmThreadId', () => {
  it('roots a top-level DM message on its own ts', () => {
    expect(normalizeDmThreadId('slack:D0123ABC:', '1724264405.531769')).toBe('slack:D0123ABC:1724264405.531769');
  });

  it('leaves an already-threaded reply untouched', () => {
    expect(normalizeDmThreadId('slack:D0123ABC:1724264405.531769', '1724264999.000100')).toBe(
      'slack:D0123ABC:1724264405.531769',
    );
  });

  it('ignores encoded (non-ts) message ids', () => {
    expect(normalizeDmThreadId('slack:D0123ABC:', 'ephemeral:1724:url')).toBe('slack:D0123ABC:');
  });

  it('ignores empty message ids', () => {
    expect(normalizeDmThreadId('slack:D0123ABC:', '')).toBe('slack:D0123ABC:');
  });
});
