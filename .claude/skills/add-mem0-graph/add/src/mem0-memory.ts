import { MEM0_BRIDGE_URL, MEM0_USER_ID } from './config.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryResult {
  id: string;
  memory: string;
  score?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface MemoryContext {
  coreFacts: MemoryResult[];
  conversations: MemoryResult[];
  graphEntities: Array<{ name: string; type: string; relations: string[] }>;
}

interface GraphEntity {
  name: string;
  type: string;
  relations: string[];
}

interface MemoryHistoryEntry {
  event: string;
  old_memory: string | null;
  new_memory: string | null;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let bridgeAvailable = false;

/** Regex patterns that match conversational noise (greetings, short acks). */
const NOISE_PATTERNS =
  /^(hi|hey|hello|ok|yes|no|ja|nein|danke|thanks|\u{1F44D}|\u{1F44E}|ok\s*$)/iu;

/** Messages shorter than this are considered noise candidates. */
const NOISE_MIN_LENGTH = 5;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Wrapper around fetch that handles bridge-down scenarios gracefully.
 * Returns `null` when the bridge is unavailable or the request fails.
 */
async function bridgeFetch<T>(
  endpoint: string,
  opts: {
    method?: string;
    body?: Record<string, unknown>;
    signal?: AbortSignal;
  } = {},
): Promise<T | null> {
  if (!bridgeAvailable) return null;

  const url = `${MEM0_BRIDGE_URL}${endpoint}`;
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
    if (!res.ok) {
      logger.warn(
        { endpoint, status: res.status },
        'mem0-bridge returned non-OK status',
      );
      return null;
    }
    return (await res.json()) as T;
  } catch (err: unknown) {
    // AbortError is expected when timeouts fire — don't spam logs
    if (err instanceof DOMException && err.name === 'AbortError') {
      logger.debug({ endpoint }, 'mem0-bridge request timed out');
    } else {
      logger.warn({ err, endpoint }, 'mem0-bridge request failed');
    }
    return null;
  }
}

/**
 * Return `true` when every message in the batch is noise (short greeting,
 * ack, emoji, etc.).
 */
function allNoise(
  messages: Array<{ role: string; content: string }>,
): boolean {
  return messages.every(
    (m) => m.content.length < NOISE_MIN_LENGTH || NOISE_PATTERNS.test(m.content.trim()),
  );
}

// Escape XML special characters
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Check bridge health and set module-level availability flag.
 * Safe to call multiple times — will update `bridgeAvailable` each time.
 */
export async function initMemory(): Promise<void> {
  try {
    const res = await fetch(`${MEM0_BRIDGE_URL}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      bridgeAvailable = true;
      logger.info({ url: MEM0_BRIDGE_URL }, 'mem0-bridge connected');
    } else {
      bridgeAvailable = false;
      logger.warn(
        { url: MEM0_BRIDGE_URL, status: res.status },
        'mem0-bridge health check failed — memory disabled',
      );
    }
  } catch (err) {
    bridgeAvailable = false;
    logger.warn(
      { url: MEM0_BRIDGE_URL, err },
      'mem0-bridge unavailable — memory disabled',
    );
  }
}

/**
 * Search memories by semantic similarity.
 *
 * @returns Matching memories sorted by relevance, or empty array on error.
 */
export async function searchMemories(
  query: string,
  userId: string,
  limit?: number,
): Promise<MemoryResult[]> {
  const result = await bridgeFetch<{ results: MemoryResult[] }>('/search', {
    body: { query, user_id: userId, limit: limit ?? 10 },
  });
  return result?.results ?? [];
}

/**
 * Store a conversation or set of messages as memories.
 *
 * @returns The memory ID on success, or `null` on error.
 */
export async function addMemory(opts: {
  messages: Array<{ role: string; content: string }>;
  userId: string;
  runId: string;
  metadata?: Record<string, unknown>;
}): Promise<string | null> {
  const result = await bridgeFetch<{ id: string }>('/add', {
    body: {
      messages: opts.messages,
      user_id: opts.userId,
      run_id: opts.runId,
      metadata: opts.metadata,
    },
  });
  return result?.id ?? null;
}

/**
 * Update the content of an existing memory.
 */
export async function updateMemory(
  memoryId: string,
  content: string,
): Promise<boolean> {
  const result = await bridgeFetch<{ success: boolean }>('/update', {
    body: { memory_id: memoryId, content },
  });
  return result?.success ?? false;
}

/**
 * Delete a single memory by ID.
 */
export async function removeMemory(memoryId: string): Promise<boolean> {
  const result = await bridgeFetch<{ success: boolean }>('/delete', {
    body: { memory_id: memoryId },
  });
  return result?.success ?? false;
}

/**
 * Forget all memories associated with a specific session/run.
 */
export async function forgetSession(runId: string): Promise<boolean> {
  const result = await bridgeFetch<{ success: boolean }>('/forget_session', {
    body: { run_id: runId },
  });
  return result?.success ?? false;
}

/**
 * Delete memories within a time range for a user.
 *
 * @param userId  The user whose memories to prune.
 * @param before  ISO 8601 timestamp — delete memories created before this time.
 * @param after   ISO 8601 timestamp — delete memories created after this time.
 * @returns Number of memories deleted.
 */
export async function forgetTimerange(
  userId: string,
  before?: string,
  after?: string,
): Promise<number> {
  const result = await bridgeFetch<{ deleted_count: number }>(
    '/forget_timerange',
    { body: { user_id: userId, before, after } },
  );
  return result?.deleted_count ?? 0;
}

/**
 * Search the knowledge graph for entities related to a query.
 */
export async function searchGraph(
  query: string,
  userId: string,
): Promise<GraphEntity[]> {
  const result = await bridgeFetch<{ entities: GraphEntity[] }>(
    '/graph_search',
    { body: { query, user_id: userId } },
  );
  return result?.entities ?? [];
}

/**
 * Retrieve the edit history of a specific memory.
 */
export async function getMemoryHistory(
  memoryId: string,
): Promise<MemoryHistoryEntry[]> {
  const result = await bridgeFetch<{ history: MemoryHistoryEntry[] }>(
    '/history',
    { body: { memory_id: memoryId } },
  );
  return result?.history ?? [];
}

/**
 * Main pre-invocation recall function.
 *
 * Builds a query from recent messages, retrieves semantic memories and graph
 * entities in parallel (with a strict 200 ms timeout), and formats results as
 * an XML block suitable for injection into the agent system prompt.
 *
 * Returns an empty string when the bridge is down, the timeout fires, or no
 * relevant memories are found — the agent runs normally without memory in
 * those cases.
 */
export async function retrieveMemoryContext(
  groupFolder: string,
  userId: string,
  messages: Array<{ content: string; sender_name?: string }>,
): Promise<string> {
  if (!bridgeAvailable) return '';

  // Build query from last 3 messages
  const recentMessages = messages.slice(-3);
  const query = recentMessages.map((m) => m.content).join('\n');
  if (!query.trim()) return '';

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 200);

  try {
    const [memories, entities] = await Promise.all([
      bridgeFetch<{ results: MemoryResult[] }>('/search', {
        body: { query, user_id: userId, limit: 10 },
        signal: abortController.signal,
      }),
      bridgeFetch<{ entities: GraphEntity[] }>('/graph_search', {
        body: { query, user_id: userId },
        signal: abortController.signal,
      }),
    ]);

    clearTimeout(timeout);

    const coreFacts = (memories?.results ?? []).filter(
      (m) => m.metadata?.type === 'core_fact' || m.metadata?.category,
    );
    const conversations = (memories?.results ?? []).filter(
      (m) => !m.metadata?.type || m.metadata?.type !== 'core_fact',
    );
    const graphEntities = entities?.entities ?? [];

    // Nothing to inject
    if (
      coreFacts.length === 0 &&
      conversations.length === 0 &&
      graphEntities.length === 0
    ) {
      return '';
    }

    // Format as XML
    const lines: string[] = ['<memory>'];

    if (coreFacts.length > 0) {
      lines.push('  <core_facts>');
      for (const fact of coreFacts) {
        const category = (fact.metadata?.category as string) ?? 'general';
        lines.push(
          `    <fact id="${escapeXml(fact.id)}" category="${escapeXml(category)}">${escapeXml(fact.memory)}</fact>`,
        );
      }
      lines.push('  </core_facts>');
    }

    if (conversations.length > 0) {
      lines.push('  <past_conversations>');
      for (const msg of conversations) {
        const time = msg.created_at ?? '';
        const sender = (msg.metadata?.sender as string) ?? '';
        lines.push(
          `    <msg time="${escapeXml(time)}" sender="${escapeXml(sender)}">${escapeXml(msg.memory)}</msg>`,
        );
      }
      lines.push('  </past_conversations>');
    }

    if (graphEntities.length > 0) {
      lines.push('  <graph_context>');
      for (const entity of graphEntities) {
        const relations = entity.relations.join(', ');
        lines.push(
          `    <entity name="${escapeXml(entity.name)}" type="${escapeXml(entity.type)}" relations="${escapeXml(relations)}"/>`,
        );
      }
      lines.push('  </graph_context>');
    }

    lines.push('</memory>');
    return lines.join('\n');
  } catch (err: unknown) {
    clearTimeout(timeout);
    // AbortError from timeout — expected, not an error
    if (err instanceof DOMException && err.name === 'AbortError') {
      logger.debug('Memory recall timed out (200ms) — skipping injection');
    } else {
      logger.warn({ err }, 'Memory recall failed — skipping injection');
    }
    return '';
  }
}

/**
 * Fire-and-forget post-conversation capture.
 *
 * Extracts useful information from the conversation and stores it in mem0.
 * Silently skips when the bridge is down or the conversation is pure noise
 * (greetings, short acks, emoji).
 */
export async function captureConversation(
  groupFolder: string,
  userId: string,
  sessionId: string,
  sessionMode: string,
  messages: Array<{
    role: string;
    content: string;
    sender_name?: string;
    timestamp?: string;
  }>,
): Promise<void> {
  if (!bridgeAvailable) return;

  // Noise filter: skip if all messages are trivial
  if (allNoise(messages)) {
    logger.debug(
      { groupFolder, sessionId },
      'Skipping memory capture — conversation is noise',
    );
    return;
  }

  const runId = `${groupFolder}:${sessionId}:${sessionMode}`;

  try {
    await addMemory({
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      userId,
      runId,
      metadata: {
        group_folder: groupFolder,
        session_id: sessionId,
        session_mode: sessionMode,
      },
    });
    logger.debug({ runId, messageCount: messages.length }, 'Memory captured');
  } catch (err) {
    logger.warn({ err, runId }, 'Memory capture failed — non-blocking');
  }
}
