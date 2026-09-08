import { describe, expect, it } from 'bun:test';

import { fetchOllamaWebPage } from './ollama-web.js';

function fakeFetch(response: Response, inspect?: (input: URL | RequestInfo, init?: RequestInit) => void): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    inspect?.(input, init);
    return response;
  }) as typeof fetch;
}

describe('Ollama Web Fetch adapter', () => {
  it('calls only the signed local daemon and returns bounded page content', async () => {
    let requestBody = '';
    const result = await fetchOllamaWebPage(
      { url: 'https://example.com/article', prompt: 'summarize it' },
      fakeFetch(
        Response.json({ title: 'Example', content: 'Article body', links: ['https://example.com/next'] }),
        (input, init) => {
          expect(String(input)).toBe('http://host.docker.internal:11434/api/experimental/web_fetch');
          expect(init?.headers).toEqual({ 'content-type': 'application/json' });
          requestBody = String(init?.body);
        },
      ),
      'http://host.docker.internal:11434',
    );

    expect(JSON.parse(requestBody)).toEqual({ url: 'https://example.com/article' });
    expect(result).toEqual({
      ok: true,
      text: 'Title: Example\nURL: https://example.com/article\n\nArticle body\n\nLinks:\n- https://example.com/next',
    });
  });

  it('rejects local, credentialed, and non-HTTP targets before making a request', async () => {
    let calls = 0;
    const fetchImpl = fakeFetch(Response.json({}), () => calls++);
    for (const url of [
      'http://127.0.0.1/admin',
      'http://[::1]/admin',
      'http://100.64.0.1/admin',
      'https://user:secret@example.com',
      'file:///etc/passwd',
    ]) {
      expect(await fetchOllamaWebPage({ url, prompt: 'read' }, fetchImpl, 'http://ollama.test')).toMatchObject({
        ok: false,
      });
    }
    expect(calls).toBe(0);
  });

  it('accepts a successful response without optional links', async () => {
    const result = await fetchOllamaWebPage(
      { url: 'https://example.com', prompt: 'read' },
      fakeFetch(Response.json({ title: 'Example', content: 'Body' })),
      'http://ollama.test',
    );
    expect(result).toEqual({ ok: true, text: 'Title: Example\nURL: https://example.com/\n\nBody' });
  });

  it.each([
    [401, { error: 'unauthorized', signin_url: 'https://ollama.com/connect/x' }, 'Sign in on the host'],
    [403, { error: 'ollama cloud is disabled' }, 'Enable Cloud on the host'],
    [404, { error: 'not found' }, 'Try another result or URL'],
    [429, { error: 'rate limited' }, 'usage is exhausted or rate-limited'],
  ])('maps HTTP %i to an actionable failure', async (status, body, expected) => {
    const result = await fetchOllamaWebPage(
      { url: 'https://example.com', prompt: 'read' },
      fakeFetch(Response.json(body, { status })),
      'http://ollama.test',
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain(expected);
  });

  it('rejects malformed successful responses', async () => {
    const result = await fetchOllamaWebPage(
      { url: 'https://example.com', prompt: 'read' },
      fakeFetch(Response.json({ title: 'missing content' })),
      'http://ollama.test',
    );
    expect(result).toEqual({ ok: false, message: 'Ollama Web Fetch returned an unexpected response shape.' });
  });

  it('distinguishes a missing local proxy route from a target URL 404', async () => {
    const result = await fetchOllamaWebPage(
      { url: 'https://example.com', prompt: 'read' },
      fakeFetch(new Response('404 page not found', { status: 404 })),
      'http://ollama.test',
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain('Update Ollama');
  });
});
