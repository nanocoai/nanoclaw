/**
 * Structural GET-only enforcement for the Trello read client -- the one
 * chokepoint every Trello-facing tool must go through. These tests exist
 * to prove requirement #4 of the Trello read-access upgrade: no mutation
 * request can pass through this helper, by construction.
 *
 * Ported verbatim from old commit 824318ff -- no DB access, no adaptation
 * needed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { trelloGet, TrelloReadClientError } from './trello-read-client.js';

let calls: { url: string; init: RequestInit | undefined }[] = [];
let originalFetch: typeof fetch;

function stubFetch(body: unknown = {}, ok = true, status = 200): void {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: input.toString(), init });
    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'Error',
      json: async () => body,
    } as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('trelloGet — allowlisted paths', () => {
  it('allows GET /1/members/me', async () => {
    stubFetch({ id: 'abc' });
    const result = await trelloGet('/1/members/me', { fields: 'id,username' });
    expect(result).toEqual({ id: 'abc' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('https://api.trello.com/1/members/me');
    expect(calls[0].url).toContain('fields=id%2Cusername');
  });

  it('allows GET /1/members/me/boards', async () => {
    stubFetch([]);
    await trelloGet('/1/members/me/boards', { fields: 'id,name' });
    expect(calls[0].url).toContain('/1/members/me/boards');
  });

  it('allows GET /1/boards/:id', async () => {
    stubFetch({});
    await trelloGet('/1/boards/507f1f77bcf86cd799439011', {});
    expect(calls[0].url).toContain('/1/boards/507f1f77bcf86cd799439011');
  });

  it('allows GET /1/cards/:id', async () => {
    stubFetch({});
    await trelloGet('/1/cards/6a31fba106ec4ad2f987fe1e', {});
    expect(calls[0].url).toContain('/1/cards/6a31fba106ec4ad2f987fe1e');
  });

  it('allows GET /1/search', async () => {
    stubFetch({ cards: [] });
    await trelloGet('/1/search', { query: '115 Edgewood' });
    expect(calls[0].url).toContain('/1/search');
  });
});

describe('trelloGet — structural GET-only guarantees', () => {
  it('always issues method GET, never anything else', async () => {
    stubFetch({});
    await trelloGet('/1/members/me', {});
    expect(calls[0].init?.method).toBe('GET');
  });

  it('never attaches a request body', async () => {
    stubFetch({});
    await trelloGet('/1/search', { query: 'x' });
    expect(calls[0].init).not.toHaveProperty('body');
  });

  it('has no parameter through which a caller could request a non-GET method', () => {
    // The function's own arity/shape is the guarantee: (path, params) only.
    expect(trelloGet.length).toBeLessThanOrEqual(2);
  });
});

describe('trelloGet — allowlist rejection (fails closed)', () => {
  it('rejects a path not on the allowlist', async () => {
    stubFetch({});
    await expect(trelloGet('/1/cards/abc/actions', {})).rejects.toThrow(TrelloReadClientError);
    expect(calls).toHaveLength(0);
  });

  it('rejects a write-shaped path even if it looks read-adjacent', async () => {
    stubFetch({});
    await expect(trelloGet('/1/cards/abc/closed', {})).rejects.toThrow(TrelloReadClientError);
    expect(calls).toHaveLength(0);
  });

  it('rejects an empty path', async () => {
    stubFetch({});
    await expect(trelloGet('', {})).rejects.toThrow(TrelloReadClientError);
    expect(calls).toHaveLength(0);
  });

  it('rejects a path attempting to target a different host via path traversal', async () => {
    stubFetch({});
    await expect(trelloGet('/1/boards/x/../../evil', {})).rejects.toThrow(TrelloReadClientError);
    expect(calls).toHaveLength(0);
  });
});

describe('trelloGet — error propagation', () => {
  it('throws on a non-2xx response rather than returning a partial/empty result silently', async () => {
    stubFetch({}, false, 401);
    await expect(trelloGet('/1/members/me', {})).rejects.toThrow(TrelloReadClientError);
  });
});
