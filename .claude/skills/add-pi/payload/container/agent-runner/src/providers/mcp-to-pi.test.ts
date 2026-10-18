import { describe, expect, it } from 'bun:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js';

import {
  createToolNamer,
  mapContentBlocks,
  sanitizeToolName,
  toStdioServerParameters,
  wrapMcpTool,
  type McpBridgeOptions,
  type McpConnection,
} from './mcp-to-pi.js';
import type { McpServerConfig } from './types.js';

// ---------------------------------------------------------------------------
// sanitizeToolName / createToolNamer
// ---------------------------------------------------------------------------

describe('sanitizeToolName', () => {
  it('builds the mcp__<server>__<tool> prefix', () => {
    expect(sanitizeToolName('nanoclaw', 'send_message')).toBe('mcp__nanoclaw__send_message');
  });

  it('folds chars outside [A-Za-z0-9_-] to underscore', () => {
    expect(sanitizeToolName('my.server', 'a:b/c')).toBe('mcp__my_server__a_b_c');
  });

  it('folds non-ascii names to underscores', () => {
    expect(sanitizeToolName('srv', '工具')).toBe('mcp__srv____');
  });
});

describe('createToolNamer', () => {
  it('appends a suffix when sanitized names collide', () => {
    const log: string[] = [];
    const namer = createToolNamer((m) => log.push(m));
    expect(namer('s', 'a.b')).toBe('mcp__s__a_b');
    expect(namer('s', 'a_b')).toBe('mcp__s__a_b_2');
    expect(namer('s', 'a:b')).toBe('mcp__s__a_b_3');
    expect(log).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// toStdioServerParameters (config → StdioServerParameters shape)
// ---------------------------------------------------------------------------

describe('toStdioServerParameters', () => {
  it('maps command/args and defaults args to []', () => {
    const p = toStdioServerParameters({ command: 'bun', args: ['run', 'x.ts'] });
    expect(p).toEqual({ command: 'bun', args: ['run', 'x.ts'] });
    expect(toStdioServerParameters({ command: 'bun' }).args).toEqual([]);
  });

  it('omits the env key for env:{} and undefined (R6: default environment must survive)', () => {
    // The built-in nanoclaw server stamps env:{} — a literal empty env would
    // starve the child of PATH, so the key must be absent entirely.
    expect('env' in toStdioServerParameters({ command: 'bun', env: {} })).toBe(false);
    expect('env' in toStdioServerParameters({ command: 'bun' })).toBe(false);
  });

  it('passes a non-empty env through verbatim', () => {
    const p = toStdioServerParameters({ command: 'bun', env: { FOO: 'bar' } });
    expect(p.env).toEqual({ FOO: 'bar' });
  });

  it('passes cwd through natively (no shim) and omits it when absent', () => {
    expect(toStdioServerParameters({ command: 'bun', cwd: '/abs/dir' }).cwd).toBe('/abs/dir');
    expect('cwd' in toStdioServerParameters({ command: 'bun' })).toBe(false);
  });

  it('defensively ignores pluginRoot', () => {
    const cfg: McpServerConfig = { command: 'bun', pluginRoot: '/container/plugin' };
    expect(toStdioServerParameters(cfg)).toEqual({ command: 'bun', args: [] });
  });
});

// ---------------------------------------------------------------------------
// mapContentBlocks
// ---------------------------------------------------------------------------

describe('mapContentBlocks', () => {
  const opts: McpBridgeOptions = {};

  it('passes text and image blocks through', () => {
    const out = mapContentBlocks(
      {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ],
      } as never,
      opts,
    );
    expect(out).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ]);
  });

  it('truncates oversized text with a marker', () => {
    const out = mapContentBlocks({ content: [{ type: 'text', text: 'x'.repeat(12) }] } as never, {
      maxTextChars: 10,
    });
    expect(out).toEqual([{ type: 'text', text: `${'x'.repeat(10)}\n[truncated]` }]);
  });

  it('degrades audio to a text placeholder', () => {
    const out = mapContentBlocks(
      { content: [{ type: 'audio', data: 'QUJD', mimeType: 'audio/wav' }] } as never,
      opts,
    );
    expect(out).toEqual([
      { type: 'text', text: expect.stringContaining('audio: audio/wav') },
    ]);
  });

  it('renders resource_link as text', () => {
    const out = mapContentBlocks(
      {
        content: [{ type: 'resource_link', uri: 'file:///tmp/a.txt', name: 'a.txt' }],
      } as never,
      opts,
    );
    expect(out).toEqual([{ type: 'text', text: 'resource: file:///tmp/a.txt (a.txt)' }]);
  });

  it('passes text resources through and degrades blob resources', () => {
    const out = mapContentBlocks(
      {
        content: [
          { type: 'resource', resource: { uri: 'file:///t.md', text: '# md body' } },
          {
            type: 'resource',
            resource: { uri: 'file:///t.bin', mimeType: 'application/octet-stream', blob: 'REY=' },
          },
        ],
      } as never,
      opts,
    );
    expect(out).toEqual([
      { type: 'text', text: '# md body' },
      { type: 'text', text: expect.stringContaining('file:///t.bin') },
    ]);
  });

  it('appends structuredContent as a JSON text block after content', () => {
    const out = mapContentBlocks(
      {
        content: [{ type: 'text', text: 'done' }],
        structuredContent: { total: 3 },
      } as never,
      opts,
    );
    expect(out).toEqual([
      { type: 'text', text: 'done' },
      { type: 'text', text: '{"total":3}' },
    ]);
  });

  it('returns [] for an empty result and skips unknown block types', () => {
    expect(mapContentBlocks({ content: [] } as never, opts)).toEqual([]);
    const weird = { content: [{ type: 'hologram' }] } as never;
    expect(mapContentBlocks(weird, opts)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// wrapMcpTool end-to-end over InMemoryTransport
// ---------------------------------------------------------------------------

type ToolHandlers = {
  listTools: () => { tools: McpTool[] };
  callTool: (name: string, args: Record<string, unknown> | undefined) => Record<string, unknown>;
};

async function makeInMemoryConnection(name: string, handlers: ToolHandlers): Promise<McpConnection> {
  const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => handlers.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    handlers.callTool(req.params.name, req.params.arguments as Record<string, unknown> | undefined),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pi-bridge-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { name, ensureClient: async () => client };
}

const ECHO_TOOL: McpTool = {
  name: 'echo',
  description: 'Echo the input back',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
};

describe('wrapMcpTool (end-to-end over InMemoryTransport)', () => {
  it('forwards calls and maps the result content', async () => {
    const conn = await makeInMemoryConnection('testsrv', {
      listTools: () => ({ tools: [ECHO_TOOL] }),
      callTool: (_name, args) => ({
        content: [{ type: 'text', text: `echo:${args?.text}` }],
      }),
    });
    const def = wrapMcpTool(conn, ECHO_TOOL, {}, 'mcp__testsrv__echo');

    expect(def.name).toBe('mcp__testsrv__echo');
    expect(def.label).toBe('echo');
    expect(def.executionMode).toBe('sequential');

    const res = await def.execute('call-1', { text: 'hi' } as never, undefined, undefined, {} as never);
    expect(res.content).toEqual([{ type: 'text', text: 'echo:hi' }]);
    expect(res.details).toEqual({ mcpServer: 'testsrv' });
  });

  it('THROWS on isError:true results (pi ignores isError on resolved executes, R4)', async () => {
    const conn = await makeInMemoryConnection('testsrv', {
      listTools: () => ({ tools: [ECHO_TOOL] }),
      callTool: () => ({ content: [{ type: 'text', text: 'boom: bad input' }], isError: true }),
    });
    const def = wrapMcpTool(conn, ECHO_TOOL, {}, 'mcp__testsrv__echo');
    expect(
      def.execute('call-2', { text: 'x' } as never, undefined, undefined, {} as never),
    ).rejects.toThrow('boom: bad input');
  });

  it('falls back to a generic message when an isError result carries no text', async () => {
    const conn = await makeInMemoryConnection('testsrv', {
      listTools: () => ({ tools: [ECHO_TOOL] }),
      callTool: () => ({ content: [], isError: true }),
    });
    const def = wrapMcpTool(conn, ECHO_TOOL, {}, 'mcp__testsrv__echo');
    expect(def.execute('call-3', { text: 'x' } as never, undefined, undefined, {} as never)).rejects.toThrow(
      'MCP tool echo failed',
    );
  });

  it('forwards an abort signal into the call chain (cancelled request rejects)', async () => {
    const conn = await makeInMemoryConnection('testsrv', {
      listTools: () => ({ tools: [ECHO_TOOL] }),
      callTool: () => new Promise(() => {}), // never resolves
    });
    const def = wrapMcpTool(conn, ECHO_TOOL, { callTimeoutMs: 5_000 }, 'mcp__testsrv__echo');
    const ac = new AbortController();
    const pending = def.execute('call-4', { text: 'x' } as never, ac.signal, undefined, {} as never);
    setTimeout(() => ac.abort(), 20);
    expect(pending).rejects.toThrow();
  });

  it('reports the server name when the connection cannot be established', async () => {
    const conn: McpConnection = {
      name: 'deadsrv',
      ensureClient: async () => {
        throw new Error('nope');
      },
    };
    const def = wrapMcpTool(conn, ECHO_TOOL, {}, 'mcp__deadsrv__echo');
    expect(def.execute('call-5', { text: 'x' } as never, undefined, undefined, {} as never)).rejects.toThrow(
      'MCP server "deadsrv" unavailable: nope',
    );
  });
});
