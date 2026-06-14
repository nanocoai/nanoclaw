/**
 * MemU Proxy — provides structured agent memory via HTTP.
 *
 * Runs on the host. Containers access it via HTTP (same pattern as GOG proxy).
 * Stores memories in SQLite with per-group isolation. Supports:
 *   - Explicit memory storage (corrections, preferences, learnings)
 *   - Transcript memorization (pre-compaction auto-flush)
 *   - Ollama-based semantic search (nomic-embed-text embeddings)
 *   - Auto-promotion of reinforced memories to CLAUDE.md
 *   - Context injection endpoint for session-start memory loading
 *
 * POST /store     { groupFolder, content, type, tags? }
 * POST /retrieve  { groupFolder, query, limit?, types? }
 * POST /search    { groupFolder, query, limit? }
 * POST /memorize  { groupFolder, content, sessionId? }
 * POST /context   { groupFolder, prompt? }  — returns memories for injection
 * POST /delete    { groupFolder, id }
 * POST /stats     { groupFolder }
 */
import { createServer, Server } from 'http';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

let db: Database.Database;

// --- Ollama Embedding Engine ---

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: text }),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status }, 'Ollama embed request failed');
      return null;
    }
    const data = (await resp.json()) as { embeddings: number[][] };
    return data.embeddings[0] || null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Ollama embed error (is ollama running?)',
    );
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

// --- Schema ---

function initMemuDb(): void {
  const dbPath = path.join(DATA_DIR, 'memu.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'knowledge',
      content TEXT NOT NULL,
      tags TEXT DEFAULT '[]',
      source TEXT DEFAULT 'explicit',
      reinforcement_count INTEGER DEFAULT 1,
      last_reinforced_at TEXT,
      promoted INTEGER DEFAULT 0,
      embedding TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_group ON memories(group_folder);
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);

    CREATE TABLE IF NOT EXISTS memory_chunks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      session_id TEXT,
      content TEXT NOT NULL,
      chunk_index INTEGER DEFAULT 0,
      embedding TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_group ON memory_chunks(group_folder);
  `);

  // Migrations for existing DBs
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN promoted INTEGER DEFAULT 0`);
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN embedding TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE memory_chunks ADD COLUMN embedding TEXT`);
  } catch {
    /* column already exists */
  }
}

// --- Memory operations ---

type MemoryType =
  | 'profile'
  | 'event'
  | 'knowledge'
  | 'behavior'
  | 'skill'
  | 'tool';

interface Memory {
  id: string;
  group_folder: string;
  type: MemoryType;
  content: string;
  tags: string[];
  source: string;
  reinforcement_count: number;
  promoted: number;
  created_at: string;
  updated_at: string;
}

interface MemoryRow extends Omit<Memory, 'tags'> {
  tags: string;
  embedding: string | null;
}

function generateId(): string {
  return `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Strip leading list/quote markers so a re-ingested CLAUDE.md bullet
// doesn't become a deeper bullet on every promote/inject cycle. Without
// this, "- foo" → "- - foo" → "- - - foo" each round.
function stripLineMarkers(s: string): string {
  return s.replace(/^(?:\s*(?:[-*+•]|>)+)+\s*/, '').trim();
}

async function storeMemory(
  groupFolder: string,
  content: string,
  type: MemoryType = 'knowledge',
  tags: string[] = [],
  source: string = 'explicit',
): Promise<string> {
  content = stripLineMarkers(content);
  if (!content) {
    throw new Error('storeMemory: content is empty after marker normalization');
  }

  // Check for duplicate/similar content — reinforce if exists. Insert-time
  // normalization (above) means new rows are bullet-free, so exact match is
  // sufficient to deduplicate going forward.
  const existing = db
    .prepare(
      `SELECT id, reinforcement_count FROM memories
       WHERE group_folder = ? AND content = ? AND type = ?`,
    )
    .get(groupFolder, content, type) as
    | { id: string; reinforcement_count: number }
    | undefined;

  const now = new Date().toISOString();

  if (existing) {
    const newCount = existing.reinforcement_count + 1;
    db.prepare(
      `UPDATE memories SET reinforcement_count = ?,
       last_reinforced_at = ?, updated_at = ? WHERE id = ?`,
    ).run(newCount, now, now, existing.id);

    return existing.id;
  }

  const id = generateId();

  // Get embedding asynchronously — store memory immediately, embed in background
  db.prepare(
    `INSERT INTO memories (id, group_folder, type, content, tags, source, promoted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(id, groupFolder, type, content, JSON.stringify(tags), source, now, now);

  // Embed in background (non-blocking)
  getEmbedding(content).then((emb) => {
    if (emb) {
      db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(
        JSON.stringify(emb),
        id,
      );
    }
  });

  return id;
}

async function retrieveMemories(
  groupFolder: string,
  query: string,
  limit: number = 10,
  types?: MemoryType[],
): Promise<Memory[]> {
  const typeFilter =
    types && types.length > 0
      ? `AND type IN (${types.map(() => '?').join(',')})`
      : '';
  const typeParams = types && types.length > 0 ? types : [];

  const candidates = db
    .prepare(`SELECT * FROM memories WHERE group_folder = ? ${typeFilter}`)
    .all(groupFolder, ...typeParams) as MemoryRow[];

  if (candidates.length === 0) return [];

  if (!query.trim()) {
    return candidates
      .sort(
        (a, b) =>
          b.reinforcement_count - a.reinforcement_count ||
          b.updated_at.localeCompare(a.updated_at),
      )
      .slice(0, limit)
      .map(parseMemoryRow);
  }

  // Get query embedding from Ollama
  const queryEmb = await getEmbedding(query);

  if (!queryEmb) {
    // Ollama unavailable — fall back to simple keyword matching
    return keywordFallback(candidates, query, limit);
  }

  // Score each memory by cosine similarity
  const scored = candidates.map((mem) => {
    let score = 0;
    if (mem.embedding) {
      try {
        const memEmb = JSON.parse(mem.embedding) as number[];
        score = cosineSimilarity(queryEmb, memEmb);
      } catch {
        /* bad embedding data */
      }
    }
    // Reinforcement bonus
    const reinforcementBonus = Math.log(mem.reinforcement_count + 1) * 0.02;
    // Recency bonus (within last 7 days)
    const ageMs = Date.now() - new Date(mem.updated_at).getTime();
    const recencyBonus = ageMs < 7 * 24 * 60 * 60 * 1000 ? 0.02 : 0;
    return {
      memory: mem,
      score: score + reinforcementBonus + recencyBonus,
    };
  });

  return scored
    .filter((s) => s.score > 0.3) // Cosine similarity threshold
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => parseMemoryRow(s.memory));
}

/** Simple keyword fallback when Ollama is unavailable */
function keywordFallback(
  candidates: MemoryRow[],
  query: string,
  limit: number,
): Memory[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (words.length === 0) {
    return candidates.slice(0, limit).map(parseMemoryRow);
  }

  const scored = candidates.map((mem) => {
    const lower = (mem.content + ' ' + mem.tags).toLowerCase();
    let hits = 0;
    for (const w of words) {
      if (lower.includes(w)) hits++;
    }
    return { memory: mem, score: hits };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => parseMemoryRow(s.memory));
}

function parseMemoryRow(mem: MemoryRow): Memory {
  const { embedding: _emb, ...rest } = mem;
  return {
    ...rest,
    tags: typeof rest.tags === 'string' ? JSON.parse(rest.tags) : rest.tags,
  } as Memory;
}

function deleteMemory(groupFolder: string, id: string): boolean {
  const result = db
    .prepare('DELETE FROM memories WHERE id = ? AND group_folder = ?')
    .run(id, groupFolder);
  return result.changes > 0;
}

async function memorizeTranscript(
  groupFolder: string,
  content: string,
  sessionId?: string,
): Promise<number> {
  // Strip injected <remembered-context> blocks before chunking. The agent-runner
  // wraps each user prompt with this block (sourced from the `memories` table);
  // re-chunking it produces a feedback loop where every conversation deepens the
  // corpus with copies of the same injected context. We saw 1,389 copies of one
  // 2KB block accumulate over ~2 months before the prompt exceeded the model's
  // context window. Removing it here is safe because the original memories
  // remain in the `memories` table for future injection.
  const stripped = content.replace(
    /<remembered-context>[\s\S]*?<\/remembered-context>\s*/g,
    '',
  );

  const chunks = chunkText(stripped, 500);
  const now = new Date().toISOString();

  const insert = db.prepare(
    `INSERT INTO memory_chunks (id, group_folder, session_id, content, chunk_index, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  // Belt-and-suspenders dedup: skip insert if an identical chunk already exists
  // for this group. Catches any future recursion source we haven't yet found.
  const exists = db.prepare(
    `SELECT 1 FROM memory_chunks WHERE group_folder = ? AND content = ? LIMIT 1`,
  );

  let written = 0;
  const insertMany = db.transaction((chunks: string[]) => {
    for (let i = 0; i < chunks.length; i++) {
      if (exists.get(groupFolder, chunks[i])) continue;
      insert.run(
        generateId(),
        groupFolder,
        sessionId || null,
        chunks[i],
        i,
        now,
      );
      written++;
    }
  });

  insertMany(chunks);

  // Embed chunks in background
  for (const chunk of chunks) {
    getEmbedding(chunk).then((emb) => {
      if (emb) {
        // Find the most recently inserted chunk with this content
        const row = db
          .prepare(
            `SELECT id FROM memory_chunks
             WHERE group_folder = ? AND content = ? AND created_at = ?
             ORDER BY chunk_index DESC LIMIT 1`,
          )
          .get(groupFolder, chunk, now) as { id: string } | undefined;
        if (row) {
          db.prepare('UPDATE memory_chunks SET embedding = ? WHERE id = ?').run(
            JSON.stringify(emb),
            row.id,
          );
        }
      }
    });
  }

  // Auto-extraction of "behaviors" from transcripts was REMOVED (2026-06-13
  // decommission) — it was the regex mis-capture + CLAUDE.md-bloat source.
  // Durable preferences now live in curated CLAUDE.md + Claude Code native
  // memory. memorizeTranscript's only job is to index transcript chunks so
  // mcp__memu__search / retrieve can pull them back on demand.

  return written;
}

/**
 * Get context for session-start injection.
 * Returns behavior memories (corrections, preferences) that should always
 * be loaded, plus any memories relevant to the incoming prompt.
 */

function chunkText(text: string, targetSize: number): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length > targetSize && current.length > 0) {
      chunks.push(current.trim());
      current = '';
    }
    current += para + '\n\n';
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

// --- HTTP Server ---

function parseBody(
  req: import('http').IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function jsonResponse(
  res: import('http').ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startMemuProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  initMemuDb();

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST' && req.method !== 'DELETE') {
        jsonResponse(res, 404, { status: 'error', error: 'Not found' });
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = await parseBody(req);
      } catch (err) {
        jsonResponse(res, 400, {
          status: 'error',
          error: `Bad request: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }

      const groupFolder = body.groupFolder as string;
      if (!groupFolder) {
        jsonResponse(res, 400, {
          status: 'error',
          error: 'groupFolder is required',
        });
        return;
      }

      try {
        switch (req.url) {
          case '/store': {
            const content = body.content as string;
            const type = (body.type as MemoryType) || 'knowledge';
            const tags = (body.tags as string[]) || [];
            if (!content) {
              jsonResponse(res, 400, {
                status: 'error',
                error: 'content is required',
              });
              return;
            }
            const id = await storeMemory(groupFolder, content, type, tags);
            jsonResponse(res, 200, { status: 'ok', id });
            logger.debug({ groupFolder, type, id }, 'Memory stored');
            break;
          }

          case '/retrieve': {
            const query = (body.query as string) || '';
            const limit = (body.limit as number) || 10;
            const types = body.types as MemoryType[] | undefined;
            const memories = await retrieveMemories(
              groupFolder,
              query,
              limit,
              types,
            );
            jsonResponse(res, 200, { status: 'ok', memories });
            break;
          }

          case '/search': {
            const query = (body.query as string) || '';
            const limit = (body.limit as number) || 20;
            const memories = await retrieveMemories(groupFolder, query, limit);

            // Also search transcript chunks via embeddings
            let chunks: Array<{
              content: string;
              created_at: string;
              score: number;
            }> = [];
            if (query.trim()) {
              const queryEmb = await getEmbedding(query);
              if (queryEmb) {
                const allChunks = db
                  .prepare(
                    `SELECT content, created_at, embedding FROM memory_chunks
                     WHERE group_folder = ? AND embedding IS NOT NULL
                     ORDER BY created_at DESC LIMIT 200`,
                  )
                  .all(groupFolder) as Array<{
                  content: string;
                  created_at: string;
                  embedding: string;
                }>;

                chunks = allChunks
                  .map((chunk) => {
                    let score = 0;
                    try {
                      const emb = JSON.parse(chunk.embedding) as number[];
                      score = cosineSimilarity(queryEmb, emb);
                    } catch {
                      /* skip */
                    }
                    return {
                      content: chunk.content,
                      created_at: chunk.created_at,
                      score,
                    };
                  })
                  .filter((c) => c.score > 0.3)
                  .sort((a, b) => b.score - a.score)
                  .slice(0, 5);
              }
            }

            jsonResponse(res, 200, { status: 'ok', memories, chunks });
            break;
          }

          case '/memorize': {
            const content = body.content as string;
            const sessionId = body.sessionId as string | undefined;
            if (!content) {
              jsonResponse(res, 400, {
                status: 'error',
                error: 'content is required',
              });
              return;
            }
            const chunkCount = await memorizeTranscript(
              groupFolder,
              content,
              sessionId,
            );
            jsonResponse(res, 200, { status: 'ok', chunkCount });
            logger.debug(
              { groupFolder, chunkCount, sessionId },
              'Transcript memorized',
            );
            break;
          }

          case '/memory':
          case '/delete': {
            if (!body.id) {
              jsonResponse(res, 400, {
                status: 'error',
                error: 'id is required',
              });
              return;
            }
            const deleted = deleteMemory(groupFolder, body.id as string);
            jsonResponse(res, 200, { status: 'ok', deleted });
            break;
          }

          case '/stats': {
            const memoryCount = (
              db
                .prepare(
                  'SELECT COUNT(*) as count FROM memories WHERE group_folder = ?',
                )
                .get(groupFolder) as { count: number }
            ).count;
            const chunkCount = (
              db
                .prepare(
                  'SELECT COUNT(*) as count FROM memory_chunks WHERE group_folder = ?',
                )
                .get(groupFolder) as { count: number }
            ).count;
            const byType = db
              .prepare(
                `SELECT type, COUNT(*) as count FROM memories
                 WHERE group_folder = ? GROUP BY type`,
              )
              .all(groupFolder) as Array<{ type: string; count: number }>;
            const promotedCount = (
              db
                .prepare(
                  'SELECT COUNT(*) as count FROM memories WHERE group_folder = ? AND promoted = 1',
                )
                .get(groupFolder) as { count: number }
            ).count;
            const embeddedCount = (
              db
                .prepare(
                  'SELECT COUNT(*) as count FROM memories WHERE group_folder = ? AND embedding IS NOT NULL',
                )
                .get(groupFolder) as { count: number }
            ).count;
            jsonResponse(res, 200, {
              status: 'ok',
              memoryCount,
              chunkCount,
              promotedCount,
              embeddedCount,
              byType,
            });
            break;
          }

          default:
            jsonResponse(res, 404, {
              status: 'error',
              error: `Unknown endpoint: ${req.url}`,
            });
        }
      } catch (err) {
        logger.error({ err, url: req.url }, 'MemU proxy error');
        jsonResponse(res, 500, {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    server.listen(port, host, () => {
      logger.info({ port, host, model: EMBED_MODEL }, 'MemU proxy started');
      resolve(server);
    });
    server.on('error', reject);
  });
}
