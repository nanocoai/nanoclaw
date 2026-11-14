/**
 * LanceDB long-term memory MCP server (stdio), installed by /add-lancedb-memory.
 *
 * Wraps the store, embedder and hybrid (vector + BM25) retriever of
 * memory-lancedb-pro. The library is not an agent-runner dependency: it is
 * installed per agent group with `ncl groups config add-package`, which puts it
 * in the derived image's pnpm global root. Bun does not resolve pnpm globals by
 * bare name, and the agent user cannot run `pnpm root -g` (corepack prepared
 * pnpm for root only), so the package is found under
 * `$PNPM_HOME/global/<layout>/node_modules` (`LANCEDB_MEMORY_LIB` overrides the
 * package path). It loads lazily: the
 * server always boots and lists its tools, and a missing library surfaces as a
 * tool error naming the fix.
 *
 * The database lives in the group folder, so it persists and is per group.
 * Every row uses one scope; the group boundary is the directory itself.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PACKAGE = 'memory-lancedb-pro';
const SCOPE = 'global';
const DB_DIR = process.env.LANCEDB_MEMORY_DIR || '/workspace/agent/lancedb-memory';
const CATEGORIES = ['preference', 'fact', 'decision', 'entity', 'other'] as const;

function log(msg: string): void {
  console.error(`[lancedb-memory] ${msg}`);
}

function libRoot(): string {
  if (process.env.LANCEDB_MEMORY_LIB) return process.env.LANCEDB_MEMORY_LIB;
  const globalDir = path.join(process.env.PNPM_HOME || '/pnpm', 'global');
  const found = fs.existsSync(globalDir)
    ? fs
        .readdirSync(globalDir)
        .map((layout) => path.join(globalDir, layout, 'node_modules', PACKAGE))
        .find((p) => fs.existsSync(p))
    : undefined;
  if (!found) throw new Error(`not found under ${globalDir}/*/node_modules`);
  return found;
}

async function importLibrary() {
  let root = '';
  try {
    root = libRoot();
    const mod = (file: string) => import(pathToFileURL(path.join(root, 'src', file)).href);
    return await Promise.all([mod('store.ts'), mod('embedder.ts'), mod('retriever.ts')]);
  } catch (err) {
    throw new Error(
      `${PACKAGE} could not be loaded${root ? ` from ${root}` : ''}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Install it for this group as /add-lancedb-memory describes: ncl groups config add-package --npm ${PACKAGE}@<pinned version>, then ncl groups restart --rebuild`,
      { cause: err },
    );
  }
}

async function load() {
  const [{ MemoryStore }, { createEmbedder }, { createRetriever }] = await importLibrary();
  const embedder = createEmbedder({
    provider: 'openai-compatible',
    apiKey: process.env.EMBEDDING_API_KEY || 'placeholder',
    model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    baseURL: process.env.EMBEDDING_BASE_URL || 'https://api.openai.com/v1',
    dimensions: Number(process.env.EMBEDDING_DIM) || undefined,
  });
  const store = new MemoryStore({ dbPath: DB_DIR, vectorDim: embedder.dimensions });
  const retriever = createRetriever(store, embedder, { mode: 'hybrid', rerank: 'none' });
  return { store, embedder, retriever };
}

const memory = load();
memory.catch((err: Error) => log(err.message));

function reply(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

interface Entry {
  id: string;
  text: string;
  category: string;
  importance: number;
  timestamp: number;
}

function brief(e: Entry) {
  return {
    id: e.id,
    text: e.text,
    category: e.category,
    importance: e.importance,
    stored: new Date(e.timestamp).toISOString(),
  };
}

const server = new McpServer({ name: 'lancedb_memory', version: '1.0.0' });

server.registerTool(
  'memory_recall',
  {
    description:
      'Search long-term memory by meaning and keywords (hybrid vector + BM25). Use before answering questions that may depend on earlier conversations, preferences or decisions.',
    inputSchema: {
      query: z.string().min(1).describe('What to look for, in natural language'),
      limit: z.number().int().min(1).max(20).optional().describe('Maximum results (default 5)'),
      category: z.enum(CATEGORIES).optional(),
    },
  },
  async ({ query, limit, category }) => {
    const { retriever } = await memory;
    const results: { entry: Entry; score: number }[] = await retriever.retrieve({
      query,
      limit: limit ?? 5,
      category,
      scopeFilter: [SCOPE],
      source: 'manual',
    });
    return reply(results.map((r) => ({ ...brief(r.entry), score: Number(r.score.toFixed(3)) })));
  },
);

server.registerTool(
  'memory_store',
  {
    description:
      'Save one durable fact, preference, decision or entity to long-term memory. One self-contained statement per call.',
    inputSchema: {
      text: z.string().min(1).describe('The memory, written so it makes sense without the conversation'),
      category: z.enum(CATEGORIES).optional().describe('Default "fact"'),
      importance: z.number().min(0).max(1).optional().describe('0 to 1 (default 0.7)'),
    },
  },
  async ({ text, category, importance }) => {
    const { store, embedder } = await memory;
    const entry: Entry = await store.store({
      text,
      vector: await embedder.embedPassage(text),
      category: category ?? 'fact',
      scope: SCOPE,
      importance: importance ?? 0.7,
    });
    return reply({ stored: brief(entry) });
  },
);

server.registerTool(
  'memory_update',
  {
    description: 'Correct an existing memory in place. Find the id with memory_recall or memory_list first.',
    inputSchema: {
      id: z.string().min(8).describe('Memory id (full UUID or a unique prefix of 8+ characters)'),
      text: z.string().min(1).optional(),
      category: z.enum(CATEGORIES).optional(),
      importance: z.number().min(0).max(1).optional(),
    },
  },
  async ({ id, text, category, importance }) => {
    const { store, embedder } = await memory;
    const vector = text === undefined ? undefined : await embedder.embedPassage(text);
    const entry: Entry | null = await store.update(id, { text, vector, category, importance }, [SCOPE]);
    if (!entry) throw new Error(`No memory with id ${id}`);
    return reply({ updated: brief(entry) });
  },
);

server.registerTool(
  'memory_forget',
  {
    description: 'Delete a memory that is wrong or no longer wanted.',
    inputSchema: {
      id: z.string().min(8).describe('Memory id (full UUID or a unique prefix of 8+ characters)'),
    },
  },
  async ({ id }) => {
    const { store } = await memory;
    const deleted: boolean = await store.delete(id, [SCOPE]);
    if (!deleted) throw new Error(`No memory with id ${id}`);
    return reply({ deleted: id });
  },
);

server.registerTool(
  'memory_list',
  {
    description: 'List the most recent memories, optionally of one category.',
    inputSchema: {
      category: z.enum(CATEGORIES).optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum results (default 20)'),
    },
  },
  async ({ category, limit }) => {
    const { store } = await memory;
    const entries: Entry[] = await store.list([SCOPE], category, limit ?? 20);
    return reply(entries.map(brief));
  },
);

server.registerTool(
  'memory_stats',
  {
    description: 'Count stored memories, in total and per category.',
    inputSchema: {},
  },
  async () => {
    const { store } = await memory;
    const { totalCount, categoryCounts } = await store.stats([SCOPE]);
    return reply({ total: totalCount, byCategory: categoryCounts });
  },
);

await server.connect(new StdioServerTransport());
log(`ready (db ${DB_DIR})`);
