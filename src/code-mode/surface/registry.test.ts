/**
 * The provider registry: one provider per platform, refused on a duplicate
 * or a seam mismatch (logged, listed, never thrown), change notifications
 * on register and unregister, a no-op object that opens nothing, and the
 * contract helper's answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { log } from '../../log.js';
import { resetSeamRefusalsForTesting, seamRefusals } from '../../seams.js';
import { assertSurfaceRegistered } from './contract.js';
import {
  SESSION_SURFACE_SEAM,
  getSessionSurface,
  listSessionSurfaces,
  noopSessionSurface,
  onSessionSurfaceChange,
  registerSessionSurface,
  resetSessionSurfacesForTesting,
} from './registry.js';
import type { SessionSurfaceProvider } from './types.js';

function provider(): SessionSurfaceProvider {
  return { ...noopSessionSurface, open: async () => ({ surfaceId: 'S1', sessionId: 'ag-1' }) };
}

beforeEach(() => {
  resetSessionSurfacesForTesting();
  resetSeamRefusalsForTesting();
  vi.mocked(log.error).mockClear();
});
afterEach(() => {
  resetSessionSurfacesForTesting();
  resetSeamRefusalsForTesting();
});

describe('registerSessionSurface', () => {
  it('registers one provider per platform and lists it; unregister removes it', () => {
    const p = provider();
    const off = registerSessionSurface('chat', p, { seam: SESSION_SURFACE_SEAM });
    expect(getSessionSurface('chat')).toBe(p);
    expect(listSessionSurfaces().map((e) => e.channelType)).toEqual(['chat']);
    expect(() => assertSurfaceRegistered('chat')).not.toThrow();
    off();
    expect(getSessionSurface('chat')).toBeUndefined();
    expect(() => assertSurfaceRegistered('chat')).toThrow("no session surface is registered for 'chat'");
  });

  it('a second provider for the same platform is refused and logged; the first keeps the slot', () => {
    const first = provider();
    registerSessionSurface('chat', first, { seam: SESSION_SURFACE_SEAM });
    const off = registerSessionSurface('chat', provider(), { seam: SESSION_SURFACE_SEAM });
    expect(getSessionSurface('chat')).toBe(first);
    expect(log.error).toHaveBeenCalledWith(
      'Session surface refused: a provider for this platform is already registered',
      { channelType: 'chat' },
    );
    off(); // the refused registration's undo is a no-op
    expect(getSessionSurface('chat')).toBe(first);
  });

  it('a seam mismatch is refused, listed and named by the contract helper', () => {
    registerSessionSurface('chat', provider(), { seam: SESSION_SURFACE_SEAM + 1 });
    expect(getSessionSurface('chat')).toBeUndefined();
    expect(seamRefusals()).toMatchObject([{ registry: 'session-surface', registrant: 'chat' }]);
    expect(() => assertSurfaceRegistered('chat')).toThrow(/refused: seam 1 expected, 2 given/);
  });

  it('a change listener hears each registration and unregistration, not a refused one', () => {
    const seen: Array<[string, boolean]> = [];
    const off = onSessionSurfaceChange((channelType, p) => seen.push([channelType, p !== null]));
    const p = provider();
    const unregister = registerSessionSurface('chat', p, { seam: SESSION_SURFACE_SEAM });
    registerSessionSurface('chat', provider(), { seam: SESSION_SURFACE_SEAM }); // refused: no notification
    registerSessionSurface('other', provider(), { seam: SESSION_SURFACE_SEAM + 1 }); // refused: no notification
    unregister();
    expect(seen).toEqual([
      ['chat', true],
      ['chat', false],
    ]);
    off();
    registerSessionSurface('chat', provider(), { seam: SESSION_SURFACE_SEAM });
    expect(seen).toHaveLength(2);
  });

  it('a listener that throws is logged and the others still run', () => {
    const seen: string[] = [];
    const off1 = onSessionSurfaceChange(() => {
      throw new Error('boom');
    });
    const off2 = onSessionSurfaceChange((channelType) => seen.push(channelType));
    registerSessionSurface('chat', provider(), { seam: SESSION_SURFACE_SEAM });
    expect(seen).toEqual(['chat']);
    expect(log.error).toHaveBeenCalledWith(
      'Session surface change listener failed',
      expect.objectContaining({ channelType: 'chat' }),
    );
    off1();
    off2();
  });

  it('the no-op provider opens nothing, accepts everything and returns no events', async () => {
    expect(await noopSessionSurface.open({ id: 'ag-1', name: 'x', folder: 'x' }, {})).toBeNull();
    await noopSessionSurface.status({ surfaceId: 'S', sessionId: 'ag-1' }, 'active');
    const abort = new AbortController();
    const page = noopSessionSurface.events({ surfaceId: 'S', sessionId: 'ag-1' }, 'c1', 60, abort.signal);
    abort.abort();
    expect(await page).toEqual({ events: [], cursor: 'c1' });
  });
});
