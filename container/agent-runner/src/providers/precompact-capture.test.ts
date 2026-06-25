import { afterEach, describe, expect, it } from 'bun:test';

import {
  __resetPreCompactCaptureForTest,
  applyPreCompactCapture,
  preCompactCaptureTimeoutSec,
  registerPreCompactCapture,
  type PreCompactCaptureContext,
} from './precompact-capture.js';

// Base-owned test for the PreCompact capture seam. There is NO default registrant, so this
// proves the INERT contract (no-op + undefined timeout = upstream archive-only behaviour) plus
// the registered path + best-effort isolation. A downstream memory-capture registrant is
// overlay-owned and tested separately.

const CTX: PreCompactCaptureContext = {
  messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ],
  sessionId: 'sess-1',
};

afterEach(() => __resetPreCompactCaptureForTest());

describe('precompact-capture seam — inert with no registrant', () => {
  it('applyPreCompactCapture is a no-op with no registrant (resolves, no throw)', async () => {
    __resetPreCompactCaptureForTest();
    await expect(applyPreCompactCapture(CTX)).resolves.toBeUndefined();
  });

  it('preCompactCaptureTimeoutSec() is undefined with no registrant (SDK default applies)', () => {
    __resetPreCompactCaptureForTest();
    expect(preCompactCaptureTimeoutSec()).toBeUndefined();
  });
});

describe('precompact-capture seam — registered captures', () => {
  it('runs every registered capture with the archived context', async () => {
    __resetPreCompactCaptureForTest();
    const seen: PreCompactCaptureContext[] = [];
    registerPreCompactCapture({ capture: async (ctx) => void seen.push(ctx) });
    registerPreCompactCapture({ capture: async (ctx) => void seen.push(ctx) });
    await applyPreCompactCapture(CTX);
    expect(seen).toHaveLength(2);
    expect(seen[0].messages).toEqual(CTX.messages);
    expect(seen[0].sessionId).toBe('sess-1');
  });

  it('timeout = MAX declared across registrants (widen so no capture is cut short)', () => {
    __resetPreCompactCaptureForTest();
    registerPreCompactCapture({ capture: async () => {}, timeoutSec: 30 });
    registerPreCompactCapture({ capture: async () => {} }); // no declared timeout
    registerPreCompactCapture({ capture: async () => {}, timeoutSec: 45 });
    expect(preCompactCaptureTimeoutSec()).toBe(45);
  });

  it('best-effort: a throwing capture is isolated and never breaks compaction or starves others', async () => {
    __resetPreCompactCaptureForTest();
    let ranAfter = false;
    registerPreCompactCapture({
      capture: async () => {
        throw new Error('extraction blew up');
      },
    });
    registerPreCompactCapture({ capture: async () => void (ranAfter = true) });
    await expect(applyPreCompactCapture(CTX)).resolves.toBeUndefined();
    expect(ranAfter).toBe(true);
  });
});
