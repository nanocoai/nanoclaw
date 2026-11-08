/**
 * `startMcpServer` must not resolve while the server can still use the agent
 * mailbox: the MCP entry point stops the mailbox as soon as it does.
 */
import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { registerTools, startMcpServer } from './server.js';

async function serve(): Promise<{ client: Client; serving: Promise<void>; resolved: () => boolean }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let resolved = false;
  const serving = startMcpServer(undefined, serverTransport).then(() => {
    resolved = true;
  });
  const client = new Client({ name: 'lifetime-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, serving, resolved: () => resolved };
}

describe('startMcpServer lifetime', () => {
  it('resolves only once the connection closes', async () => {
    const { client, serving, resolved } = await serve();
    await client.listTools();
    expect(resolved()).toBe(false);

    await client.close();
    await serving;
    expect(resolved()).toBe(true);
  });

  it('waits for a tool call still running when the connection closes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    registerTools([
      {
        tool: { name: 'lifetime_slow_fixture', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => {
          entered();
          await gate;
          return { content: [{ type: 'text', text: 'done' }] };
        },
      },
    ]);

    const { client, serving, resolved } = await serve();
    const call = client.callTool({ name: 'lifetime_slow_fixture', arguments: {} }).catch(() => undefined);
    await started;
    await client.close();
    await call;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved()).toBe(false);

    release();
    await serving;
    expect(resolved()).toBe(true);
  });
});
