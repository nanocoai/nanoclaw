/**
 * MemU MCP Stdio Server — runs inside the container and proxies to the
 * host's MemU HTTP proxy. Gives the agent memory tools.
 *
 * Tools:
 *   memory_retrieve — Search memories relevant to current context
 *   memory_store    — Explicitly store a learning, correction, or preference
 *   memory_search   — Search across all memories and transcript chunks
 *   memory_delete   — Remove a specific memory by ID
 *   memory_stats    — Get memory usage statistics
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const log = (msg: string) =>
  process.stderr.write(`[memu-mcp] ${msg}\n`);

const PROXY_HOST = process.env.MEMU_PROXY_HOST || 'host.docker.internal';
const PROXY_PORT = process.env.MEMU_PROXY_PORT;
const GROUP_FOLDER = process.env.NANOCLAW_GROUP_FOLDER;

if (!PROXY_PORT) {
  log('MEMU_PROXY_PORT not set — server cannot start');
  process.exit(1);
}

if (!GROUP_FOLDER) {
  log('NANOCLAW_GROUP_FOLDER not set — server cannot start');
  process.exit(1);
}

const BASE_URL = `http://${PROXY_HOST}:${PROXY_PORT}`;

async function memuRequest(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupFolder: GROUP_FOLDER, ...body }),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (data.status === 'error') {
    return `Error: ${data.error}`;
  }
  return JSON.stringify(data, null, 2);
}

const server = new McpServer({
  name: 'memu',
  version: '1.0.0',
});

// --- Memory tools ---

server.tool(
  'memory_retrieve',
  `Retrieve relevant memories for the current context. Call this when:
- Starting a complex task (to recall past learnings and preferences)
- The user references something from a previous conversation
- You need to recall corrections or preferences
- You want to check if you've handled a similar task before

Returns structured memories sorted by relevance.`,
  {
    query: z
      .string()
      .describe(
        'What to search for — describe the topic, task, or context',
      ),
    limit: z
      .number()
      .optional()
      .default(10)
      .describe('Max memories to return (default 10)'),
    types: z
      .array(
        z.enum([
          'profile',
          'event',
          'knowledge',
          'behavior',
          'skill',
          'tool',
        ]),
      )
      .optional()
      .describe(
        'Filter by memory type: profile (user info), behavior (corrections/preferences), knowledge (facts), event (things that happened), skill (learned techniques), tool (tool usage patterns)',
      ),
  },
  async ({ query, limit, types }) => {
    const output = await memuRequest('/retrieve', { query, limit, types });
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

server.tool(
  'memory_store',
  `Explicitly store a memory. Use when:
- The user corrects you ("No, I prefer X not Y")
- The user states a preference ("Always do X")
- You discover something important about how to do a task
- You learn about the user's workflow or relationships
- A tool or approach works particularly well (or poorly)

Choose the right type:
- behavior: corrections, preferences, communication style
- profile: user info (contacts, roles, companies)
- knowledge: facts, domain knowledge
- event: things that happened (meetings, decisions)
- skill: techniques that worked well
- tool: tool usage patterns and gotchas`,
  {
    content: z
      .string()
      .describe(
        'The memory to store — be specific and actionable (e.g. "User prefers informal tone in emails to John Todd")',
      ),
    type: z
      .enum(['profile', 'event', 'knowledge', 'behavior', 'skill', 'tool'])
      .describe('Memory type'),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        'Optional tags for categorization (e.g. ["email", "tone", "john-todd"])',
      ),
  },
  async ({ content, type, tags }) => {
    const output = await memuRequest('/store', { content, type, tags });
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

server.tool(
  'memory_search',
  `Full-text + semantic search across all memories AND past conversation
transcript chunks — the complete record of prior sessions. This is your
PRIMARY recall tool.

ALWAYS search here BEFORE answering any question that asks you to recall
something specific: "what did we say about X", "find the message / email /
thread about Y", "which transcript mentioned Z", "remind me what happened
with W". Do NOT answer recall questions from your current context alone —
the answer is very often in a past transcript you have not loaded. Search
first, then answer with what you actually found. If the first query misses,
retry with different terms (synonyms, names, dates) before concluding you
don't have it. Combine with the vault search tools for emails/Slack/notes.`,
  {
    query: z.string().describe('Search query'),
    limit: z
      .number()
      .optional()
      .default(20)
      .describe('Max results (default 20)'),
  },
  async ({ query, limit }) => {
    const output = await memuRequest('/search', { query, limit });
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

server.tool(
  'memory_delete',
  'Delete a specific memory by ID. Use when a memory is wrong or outdated.',
  {
    id: z.string().describe('Memory ID to delete'),
  },
  async ({ id }) => {
    const output = await memuRequest('/delete', { id });
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

server.tool(
  'memory_stats',
  'Get memory usage statistics — how many memories stored, by type, etc.',
  {},
  async () => {
    const output = await memuRequest('/stats', {});
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log('MemU MCP server connected');
