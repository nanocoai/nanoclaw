/**
 * Pins the hand-rolled MCP subset the channel server speaks — this test IS
 * the wire contract's tripwire (mailbox-channel.ts header): if the client
 * ever demands more than initialize/initialized/ping/tools, the failure
 * lands here first.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'bun:test';

import { writeSpoolEntry } from './channel-spool.js';
import { MailboxChannelServer } from './mailbox-channel.js';

interface Sent {
  id?: number | string;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  params?: Record<string, unknown>;
}

function server(overrides: Partial<ConstructorParameters<typeof MailboxChannelServer>[0]> = {}) {
  const sent: Sent[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-channel-'));
  const s = new MailboxChannelServer({
    spoolDir: dir,
    pollMs: 60_000, // tests drive emitSpool() by hand
    send: (msg) => sent.push(msg as Sent),
    ...overrides,
  });
  return { s, sent, dir };
}

async function init(s: MailboxChannelServer): Promise<void> {
  await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  s.stop(); // kill the interval the initialized handler armed; tests poll by hand
}

describe('MCP handshake', () => {
  it('declares the channel capability, tools, and instructions on initialize', async () => {
    const { s, sent } = server();
    await s.handle({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    const res = sent[0].result as {
      protocolVersion: string;
      capabilities: { experimental: Record<string, unknown>; tools: object };
      instructions: string;
      serverInfo: { name: string };
    };
    expect(sent[0].id).toBe(7);
    expect(res.protocolVersion).toBe('2024-11-05'); // echo the client's, never fight over versions
    expect(res.capabilities.experimental['claude/channel']).toEqual({});
    // Deliberately NOT declared: the permission relay is phase 3 — before
    // v2.1.234 even `false` read as declared, so the key must be absent.
    expect('claude/channel/permission' in res.capabilities.experimental).toBe(false);
    expect(res.capabilities.tools).toEqual({});
    expect(res.instructions).toContain('reply');
    expect(res.serverInfo.name).toBe('nanoclaw-mailbox');
  });

  it('answers ping, rejects unknown requests, ignores unknown notifications', async () => {
    const { s, sent } = server();
    await s.handle({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(sent[0]).toEqual({ id: 1, result: {} });
    await s.handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
    expect(sent[1].error?.code).toBe(-32601);
    await s.handle({ jsonrpc: '2.0', method: 'notifications/cancelled' });
    expect(sent).toHaveLength(2); // notifications never get a response frame
  });
});

describe('spool emission', () => {
  it('emits nothing before the client says initialized', async () => {
    const { s, sent, dir } = server();
    writeSpoolEntry({ content: 'early', meta: {} }, dir);
    await s.emitSpool();
    expect(sent).toHaveLength(0);
  });

  it('forwards entries in order as channel notifications and unlinks after the send', async () => {
    const { s, sent, dir } = server();
    await init(s);
    writeSpoolEntry({ content: 'first mail', meta: { ids: 'm1', batch: '1' } }, dir);
    writeSpoolEntry({ content: 'second mail', meta: { ids: 'm2,m3', batch: '2' } }, dir);
    await s.emitSpool();
    const notes = sent.filter((m) => m.method === 'notifications/claude/channel');
    expect(notes.map((n) => n.params)).toEqual([
      { content: 'first mail', meta: { ids: 'm1', batch: '1' } },
      { content: 'second mail', meta: { ids: 'm2,m3', batch: '2' } },
    ]);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.json'))).toEqual([]);
  });

  it('leaves an unreadable entry in place and still emits the rest', async () => {
    const { s, sent, dir } = server();
    await init(s);
    fs.writeFileSync(path.join(dir, '0000000000000-000000.json'), 'not json');
    writeSpoolEntry({ content: 'good', meta: {} }, dir);
    await s.emitSpool();
    expect(sent.filter((m) => m.method === 'notifications/claude/channel')).toHaveLength(1);
    expect(fs.readdirSync(dir)).toContain('0000000000000-000000.json');
  });
});

describe('reply tool', () => {
  it('lists exactly the reply tool with its schema', async () => {
    const { s, sent } = server();
    await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const tools = (sent[0].result as { tools: Array<{ name: string; inputSchema: { required: string[] } }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(['reply']);
    expect(tools[0].inputSchema.required).toEqual(['text']);
  });

  it('routes reply through the outbox write path, mapping reply_to', async () => {
    const calls: Record<string, unknown>[] = [];
    const { s, sent } = server({
      // The outbox write is a mailbox-seam write now, so the seam is async —
      // an object store cannot allocate a sequence synchronously.
      sendOutbox: async (args) => {
        calls.push(args as Record<string, unknown>);
        return { ok: true, data: { id: 'out-1' } } as Awaited<
          ReturnType<NonNullable<ConstructorParameters<typeof MailboxChannelServer>[0]['sendOutbox']>>
        >;
      },
    });
    await s.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'reply', arguments: { text: 'on it', reply_to: 'm7' } },
    });
    expect(calls).toEqual([{ text: 'on it', 'reply-to': 'm7' }]);
    expect((sent[0].result as { content: Array<{ text: string }> }).content[0].text).toBe('sent');
  });

  it('surfaces an outbox refusal as a tool error, never a crash', async () => {
    const { s, sent } = server({
      sendOutbox: async () =>
        ({ ok: false, error: { code: 'bad-args', message: 'text required' } }) as Awaited<
          ReturnType<NonNullable<ConstructorParameters<typeof MailboxChannelServer>[0]['sendOutbox']>>
        >,
    });
    await s.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'reply', arguments: {} } });
    const res = sent[0].result as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('text required');
    await s.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } });
    expect(sent[1].error?.code).toBe(-32602);
  });
});
