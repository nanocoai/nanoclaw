import { describe, expect, it } from 'bun:test';

import { fetchOllamaWebPage, fetchOllamaWebSearch } from './ollama-web.js';

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

describe('Ollama Web Search adapter', () => {
  it('identifies a clipped search excerpt so it cannot be mistaken for the complete page', async () => {
    const result = await fetchOllamaWebSearch(
      { query: 'article', max_results: 1 },
      fakeFetch(
        Response.json({
          results: [
            { title: 'Article', url: 'https://example.com/article', content: 'a'.repeat(4_000) + 'MISSING_TAIL' },
          ],
        }),
      ),
      'http://ollama.test',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain('MISSING_TAIL');
    expect(result.text).toContain('Excerpt truncated at 4000 characters');
    expect(result.text).toContain('ollama_web_fetch');
  });

  it('calls the signed local daemon directly and returns bounded results', async () => {
    let requestBody = '';
    const result = await fetchOllamaWebSearch(
      { query: 'latest Ollama release', max_results: 2 },
      fakeFetch(
        Response.json({
          results: [
            { title: 'Release', url: 'https://ollama.com/blog/release', content: 'Release notes' },
            { title: 'Docs', url: 'https://docs.ollama.com', content: 'Documentation' },
          ],
        }),
        (input, init) => {
          expect(String(input)).toBe('http://host.docker.internal:11434/api/experimental/web_search');
          expect(init?.headers).toEqual({ 'content-type': 'application/json' });
          requestBody = String(init?.body);
        },
      ),
      'http://host.docker.internal:11434',
    );

    expect(JSON.parse(requestBody)).toEqual({ query: 'latest Ollama release', max_results: 2 });
    expect(result).toEqual({
      ok: true,
      text:
        'Search results for: latest Ollama release\n\n' +
        '1. Release\nURL: https://ollama.com/blog/release\nRelease notes\n\n' +
        '2. Docs\nURL: https://docs.ollama.com\nDocumentation\n',
    });
  });

  it('validates the query and clamps max_results before calling Ollama', async () => {
    let requestBody = '';
    expect(
      await fetchOllamaWebSearch({ query: '   ' }, fakeFetch(Response.json({ results: [] })), 'http://x'),
    ).toMatchObject({
      ok: false,
    });
    const result = await fetchOllamaWebSearch(
      { query: 'test', max_results: 99 },
      fakeFetch(Response.json({ results: [] }), (_input, init) => {
        requestBody = String(init?.body);
      }),
      'http://ollama.test',
    );
    expect(JSON.parse(requestBody)).toEqual({ query: 'test', max_results: 10 });
    expect(result).toEqual({ ok: true, text: 'No results found for: test' });
  });

  it('maps search failures to actionable messages', async () => {
    const result = await fetchOllamaWebSearch(
      { query: 'test' },
      fakeFetch(Response.json({ error: 'unauthorized', signin_url: 'https://ollama.com/connect/x' }, { status: 401 })),
      'http://ollama.test',
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain('Sign in on the host');
  });
});
