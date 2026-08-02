import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PlayboxServer } from './server.js';

const servers: PlayboxServer[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'playbox-'));
  roots.push(root);
  const messages: unknown[] = [];
  const server = new PlayboxServer({
    port: 0,
    attachmentRoot: root,
    onInbound: (message) => {
      messages.push(message);
    },
  });
  servers.push(server);
  const port = await server.start();
  return { server, messages, baseUrl: `http://127.0.0.1:${port}` };
}

describe('PlayboxServer', () => {
  it('accepts one inbound message and rejects a duplicate id', async () => {
    const { baseUrl, messages } = await fixture();
    const message = {
      id: 'm1',
      senderId: 'playbox:alice',
      senderName: 'Alice',
      text: 'hello',
      timestamp: new Date().toISOString(),
      attachments: [],
    };
    expect(
      (
        await fetch(`${baseUrl}/api/messages`, {
          method: 'POST',
          body: JSON.stringify(message),
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await fetch(`${baseUrl}/api/messages`, {
          method: 'POST',
          body: JSON.stringify(message),
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(409);
    expect(messages).toHaveLength(1);
  });

  it('publishes outbound, typing, and delivery events and resets state', async () => {
    const { server, baseUrl } = await fixture();
    server.emit({ type: 'typing', active: true });
    server.emit({ type: 'outbound', id: 'a1', text: 'saved', files: [] });
    expect(server.events().map((event) => event.type)).toEqual(['typing', 'outbound']);
    expect((await fetch(`${baseUrl}/api/reset`, { method: 'POST' })).status).toBe(204);
    expect(server.events()).toEqual([]);
  });

  it('sets defensive headers and rejects forwarded non-loopback hosts', async () => {
    const { baseUrl } = await fixture();
    const response = await fetch(`${baseUrl}/`, { headers: { 'x-forwarded-host': 'public.example' } });
    expect(response.status).toBe(403);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('serves the browser assets without CORS or caching', async () => {
    const root = await mkdtemp(join(tmpdir(), 'playbox-static-'));
    roots.push(root);
    await writeFile(join(root, 'index.html'), '<!doctype html><title>Playbox</title>');
    const attachmentRoot = await mkdtemp(join(tmpdir(), 'playbox-files-'));
    roots.push(attachmentRoot);
    const server = new PlayboxServer({ port: 0, staticRoot: root, attachmentRoot });
    servers.push(server);
    const port = await server.start();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Playbox');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
