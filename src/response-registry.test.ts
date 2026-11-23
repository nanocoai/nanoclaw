import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResponsePayload } from './response-registry.js';

const click: ResponsePayload = {
  questionId: 'q-1',
  value: 'approve',
  userId: 'clicker',
  channelType: 'slack',
  platformId: 'C1',
  threadId: null,
};

// The registry is module state: each test gets a fresh copy.
async function freshRegistry() {
  vi.resetModules();
  return import('./response-registry.js');
}

describe('dispatchResponse', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns the owning handler's outcome and stops there", async () => {
    const { dispatchResponse, registerResponseHandler } = await freshRegistry();
    const later = vi.fn(async () => 'accepted' as const);
    registerResponseHandler(async () => false);
    registerResponseHandler(async () => 'refused');
    registerResponseHandler(later);

    expect(await dispatchResponse(click)).toBe('refused');
    expect(later).not.toHaveBeenCalled();
  });

  it('reports an early acceptance before the handler finishes its slow work', async () => {
    const { dispatchResponse, registerResponseHandler } = await freshRegistry();
    let finish!: () => void;
    const slowWork = new Promise<void>((resolve) => (finish = resolve));
    let done = false;
    registerResponseHandler(async (payload) => {
      payload.accepted?.();
      await slowWork;
      done = true;
      return 'accepted';
    });

    expect(await dispatchResponse(click)).toBe('accepted');
    expect(done).toBe(false);
    finish();
  });

  it('counts a handler that still returns true (written before outcomes) as owning the click, showing nothing', async () => {
    const { dispatchResponse, registerResponseHandler } = await freshRegistry();
    // Such handlers returned true for refused clicks too, so true can't show a decision.
    const legacy = async (): Promise<boolean> => true;
    registerResponseHandler(legacy);

    expect(await dispatchResponse(click)).toBe('ignored');
  });

  it('keeps a click with the handler that accepted it, even if its follow-up work throws', async () => {
    const { dispatchResponse, registerResponseHandler } = await freshRegistry();
    const next = vi.fn(async () => 'accepted' as const);
    registerResponseHandler(async (payload) => {
      payload.accepted?.();
      throw new Error('follow-up failed');
    });
    registerResponseHandler(next);

    expect(await dispatchResponse(click)).toBe('accepted');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(next).not.toHaveBeenCalled();
  });

  it('keeps a click with the handler that accepted it, even if it then returns false', async () => {
    const { dispatchResponse, registerResponseHandler } = await freshRegistry();
    const next = vi.fn(async () => 'accepted' as const);
    registerResponseHandler(async (payload) => {
      payload.accepted?.();
      return false;
    });
    registerResponseHandler(next);

    expect(await dispatchResponse(click)).toBe('accepted');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(next).not.toHaveBeenCalled();
  });

  it('treats an unowned or failed click as ignored', async () => {
    const { dispatchResponse, registerResponseHandler } = await freshRegistry();
    expect(await dispatchResponse(click)).toBe('ignored');

    registerResponseHandler(async () => {
      throw new Error('boom');
    });
    expect(await dispatchResponse(click)).toBe('ignored');
  });
});
