/**
 * Integration test for the LanceDB memory MCP server (container/Bun tree).
 *
 * Spawns the real server over stdio the way the provider does, so it goes red
 * when the server stops booting against the agent-runner's
 * @modelcontextprotocol/sdk and zod (the same node_modules the container
 * resolves from /app). The embedding API is a fake OpenAI-compatible endpoint.
 *
 * The store/recall round-trip needs memory-lancedb-pro, which is installed per
 * agent group in the container image rather than on the host. It runs when
 * LANCEDB_MEMORY_LIB points at an unpacked copy of the package and is skipped
 * otherwise.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = path.join(import.meta.dir, 'lancedb-memory-mcp.ts');
const DIM = 64;

// Hashed bag-of-words: texts sharing words get similar vectors.
function embed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    v[crypto.createHash('md5').update(w).digest()[0] % DIM] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

const embeddings = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const { input } = (await req.json()) as { input: string | string[] };
    const inputs = Array.isArray(input) ? input : [input];
    return Response.json({
      object: 'list',
      model: 'fake',
      data: inputs.map((t, index) => ({ object: 'embedding', index, embedding: embed(t) })),
      usage: { prompt_tokens: 0, total_tokens: 0 },
    });
  },
});

const tmpDirs: string[] = [];
const clients: Client[] = [];

async function connect(lib: string): Promise<Client> {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lancedb-memory-'));
  tmpDirs.push(dbDir);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const client = new Client({ name: 'lancedb-memory-test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: {
        ...env,
        LANCEDB_MEMORY_LIB: lib,
        LANCEDB_MEMORY_DIR: dbDir,
        EMBEDDING_BASE_URL: `http://127.0.0.1:${embeddings.port}/v1`,
        EMBEDDING_MODEL: 'fake',
        EMBEDDING_DIM: String(DIM),
        EMBEDDING_API_KEY: 'placeholder',
      },
      stderr: 'ignore',
    }),
  );
  clients.push(client);
  return client;
}

function json(result: Awaited<ReturnType<Client['callTool']>>): any {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text);
}

afterAll(async () => {
  for (const c of clients) await c.close();
  embeddings.stop(true);
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('lancedb-memory MCP server', () => {
  let missing: Client;
  beforeAll(async () => {
    missing = await connect(path.join(os.tmpdir(), 'no-such-memory-lancedb-pro'));
  });

  it('boots over stdio and lists its six tools', async () => {
    const { tools } = await missing.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'memory_forget',
      'memory_list',
      'memory_recall',
      'memory_stats',
      'memory_store',
      'memory_update',
    ]);
  });

  it('reports a missing library as a tool error that names the fix', async () => {
    const result = await missing.callTool({ name: 'memory_stats', arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content as { text: string }[];
    expect(content[0].text).toContain('ncl groups config add-package');
  });

  it.skipIf(!process.env.LANCEDB_MEMORY_LIB)('stores, recalls, updates, lists and forgets', async () => {
    const client = await connect(process.env.LANCEDB_MEMORY_LIB!);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBeFalsy();
      return json(result);
    };

    const { stored } = await call('memory_store', {
      text: 'The production board is rustclaw3 with a reserved IP',
      category: 'fact',
    });
    await call('memory_store', { text: 'User prefers short answers in German', category: 'preference' });

    const recalled = await call('memory_recall', { query: 'which board is production', limit: 1 });
    expect(recalled[0].id).toBe(stored.id);

    const { updated } = await call('memory_update', { id: stored.id, importance: 0.9 });
    expect(updated.importance).toBe(0.9);

    expect(await call('memory_list', { category: 'preference' })).toHaveLength(1);
    expect(await call('memory_forget', { id: stored.id })).toEqual({ deleted: stored.id });
    expect(await call('memory_stats', {})).toEqual({ total: 1, byCategory: { preference: 1 } });
  });
});
