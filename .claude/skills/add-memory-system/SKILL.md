---
name: add-memory-system
description: Add structured memory system with FTS5 search. Replaces unbounded CLAUDE.md memory growth with two-layer memory (facts + daily logs), a background indexer, and a memory_search MCP tool agents can use to recall past conversations.
---

# Add Structured Memory System

This skill adds a search-over-injection memory system to NanoClaw. Agents get structured memory files (facts + daily logs) and a `memory_search` MCP tool backed by SQLite FTS5 — instead of growing CLAUDE.md unbounded.

## Design Principles

- **Lossy compression > raw context** — Agents distill signal into clean facts, not raw conversation dumps
- **Search over injection** — Never auto-inject all memories; the agent searches when it needs context
- **O(log n) retrieval** — FTS5 index keeps search cost constant regardless of memory size
- **Zero new dependencies** — Uses existing SQLite/better-sqlite3, no embeddings API needed
- **Gullible Memory mitigation** — Confidence scoring + episodic traceability; conflicts flagged, not auto-resolved

## Implementation

Execute all steps in order. Each step lists the exact file to modify and what to change.

---

### Step 1: Create memory directory structure

Create `memory/` directories with seed `facts.md` for each existing group:

```bash
for group in groups/*/; do
  mkdir -p "${group}memory/daily"
  if [ ! -f "${group}memory/facts.md" ]; then
    cat > "${group}memory/facts.md" << 'FACTSEOF'
# Core Facts

## Preferences

## People

## Decisions

## Observations
FACTSEOF
  fi
done
```

Note: These directories may be gitignored (the `groups/` gitignore only allows `CLAUDE.md`). That's fine — they're created at runtime. Also ensure the `registerGroup` function in `src/index.ts` creates `memory/daily` alongside `logs/` for new groups:

In `src/index.ts`, find the `registerGroup()` function. Change the `mkdirSync` line to also create the memory directory:

```typescript
fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
fs.mkdirSync(path.join(groupDir, 'memory', 'daily'), { recursive: true });
```

---

### Step 2: Update `groups/global/CLAUDE.md` — Memory System conventions

Read `groups/global/CLAUDE.md`. Find the `## Memory` section (which currently mentions `conversations/` folder and creating files for structured data). Replace the entire `## Memory` section with:

```markdown
## Memory System

Your workspace has a structured memory system:

\`\`\`
/workspace/group/
  memory/
    facts.md         <- permanent facts (preferences, contacts, decisions)
    daily/
      YYYY-MM-DD.md  <- daily event log (append-only)
  conversations/     <- archived conversation transcripts
\`\`\`

### Rules

- **NEVER store memory in CLAUDE.md.** CLAUDE.md is for identity and instructions only.
- Use `memory/facts.md` for permanent facts. Use `memory/daily/` for daily event logs.
- Use `mcp__nanoclaw__memory_search` to search your memory and past conversations before answering questions about past events or user preferences. Don't guess -- search first if unsure.
- At the end of a conversation where you learned something noteworthy (a preference, decision, action item, or important event), write a brief entry to today's `memory/daily/YYYY-MM-DD.md`. Don't log chitchat — only things worth remembering.

### Writing to `memory/facts.md`

Distill facts -- don't store raw quotes. "User said they changed their mind about MongoDB" -> update the decision entry.

**Format:**
\`\`\`markdown
- [YYYY-MM-DD] [confidence] Distilled fact
  source: daily/YYYY-MM-DD.md#section-anchor
\`\`\`

**Confidence levels:**
- `user-stated` -- User explicitly said this. Ground truth.
- `user-confirmed` -- Agent asked, user confirmed.
- `agent-observed` -- Pattern noticed across multiple episodes. Include episode count.
- `agent-inferred` -- Single inference from context. May be wrong.

**Conflict handling:**
- When a fact changes, add `supersedes:` noting the old value and date.
- If unsure which version is correct, flag both with `CONFLICTING:` -- don't silently pick one.
- Higher-confidence sources override lower ones (`user-stated` > `agent-inferred`).

**Capacity:** Max ~50 entries. When full, demote `agent-inferred` entries first, then consolidate.

### Writing to `memory/daily/YYYY-MM-DD.md`

Proactively write to this file during or at the end of any conversation where something noteworthy happened -- a user preference, a decision made, an action completed, or an important event. Don't wait for compaction; treat this as your primary logging mechanism.

Log important events, decisions, and action items -- not chitchat. Use markdown anchors (## headers) so facts.md can reference specific sections with `#section-anchor`.

### Episodic traceability

Daily logs are the evidence base. Before modifying a fact, read the source episode for context. Every fact must include a `source:` line pointing to the daily log episode(s) it was extracted from.
```

---

### Step 3: Update `groups/main/CLAUDE.md` — Trim memory section

Read `groups/main/CLAUDE.md`. Find the `## Memory` section. Replace it with:

```markdown
## Memory

See the Memory System section in global CLAUDE.md for full conventions.

Your memory lives in `memory/` -- use `memory/facts.md` for permanent facts and `memory/daily/` for daily logs. Use `mcp__nanoclaw__memory_search` to search past conversations and facts. Never store memory notes in this CLAUDE.md file.
```

---

### Step 4: Enhance PreCompact hook — Extract memory items into daily logs

Read `container/agent-runner/src/index.ts`. Find the `createPreCompactHook()` function.

After the line `log(\`Archived conversation to \${filePath}\`);` (inside the try block, after writeFileSync), add this block:

```typescript
// Extract key facts/events into daily memory log
try {
  const extracted = extractMemoryItems(messages);
  if (extracted.length > 0) {
    const dailyDir = '/workspace/group/memory/daily';
    fs.mkdirSync(dailyDir, { recursive: true });
    const dailyPath = path.join(dailyDir, `${date}.md`);

    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const header = `## ${time} — ${summary || 'Conversation'}\n`;
    const items = extracted.map(item => `- ${item}`).join('\n');
    const entry = `\n${header}\n${items}\n`;

    fs.appendFileSync(dailyPath, entry);
    log(`Extracted ${extracted.length} memory items to ${dailyPath}`);
  }
} catch (memErr) {
  log(`Failed to extract memory items: ${memErr instanceof Error ? memErr.message : String(memErr)}`);
}
```

Then add this new function after `createPreCompactHook()` (before `createSanitizeBashHook()`):

```typescript
/**
 * Best-effort regex extraction of memory-worthy items from a conversation.
 * Looks for explicit "I'll remember" patterns from the assistant and
 * preference/decision statements from the user.
 */
function extractMemoryItems(messages: ParsedMessage[]): string[] {
  const items: string[] = [];

  const assistantRememberPatterns = [
    /(?:I'll|I will|I'm going to)\s+(?:remember|note|keep in mind|record)\s+(?:that\s+)?(.{10,120})/gi,
    /(?:Noted|Got it|Understood)[.:]\s*(.{10,120})/gi,
  ];

  const userPreferencePatterns = [
    /(?:I\s+(?:prefer|like|want|need|always|never|don't like|hate))\s+(.{5,120})/gi,
    /(?:(?:let's|we should|we'll|going to|decided to|decision is to))\s+(.{5,120})/gi,
    /(?:my\s+(?:name|email|phone|address|birthday)\s+is)\s+(.{3,80})/gi,
    /(?:(?:call me|I'm called|I go by))\s+(.{2,40})/gi,
  ];

  for (const msg of messages) {
    const patterns = msg.role === 'assistant' ? assistantRememberPatterns : userPreferencePatterns;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(msg.content)) !== null) {
        const item = match[1].trim().replace(/[.\n]+$/, '');
        if (item.length >= 5 && !items.includes(item)) {
          items.push(`[${msg.role}] ${item}`);
        }
        if (items.length >= 10) break;
      }
      if (items.length >= 10) break;
    }
    if (items.length >= 10) break;
  }

  return items;
}
```

---

### Step 5: Add SQLite tables to `src/db.ts`

Read `src/db.ts`. Find the `createSchema()` function.

**5a.** Inside the main `database.exec(...)` template literal, before the `CREATE TABLE IF NOT EXISTS router_state` line, add:

```sql
CREATE TABLE IF NOT EXISTS memory_chunks (
  id TEXT PRIMARY KEY,
  group_folder TEXT NOT NULL,
  source_file TEXT NOT NULL,
  content TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_group ON memory_chunks(group_folder);
```

**5b.** After the closing `);` of the main `database.exec(...)` call (before the migration try/catch blocks), add:

```typescript
// Create FTS5 virtual table for memory search
try {
  database.exec(`
    CREATE VIRTUAL TABLE memory_chunks_fts USING fts5(
      content, group_folder UNINDEXED, chunk_id UNINDEXED
    );
  `);
} catch {
  /* table already exists */
}
```

**5c.** Before the `// --- JSON migration ---` comment, add these functions:

```typescript
// --- Memory search ---

export interface MemoryChunk {
  id: string;
  group_folder: string;
  source_file: string;
  content: string;
  line_start: number | null;
  line_end: number | null;
  created_at: string;
  updated_at: string;
}

export interface MemorySearchResult {
  content: string;
  source_file: string;
  group_folder: string;
  rank: number;
}

export function searchMemory(
  query: string,
  groupFolder: string,
  limit: number = 5,
): MemorySearchResult[] {
  const sql = `
    SELECT
      mc.content,
      mc.source_file,
      mc.group_folder,
      rank
    FROM memory_chunks_fts fts
    JOIN memory_chunks mc ON mc.id = fts.chunk_id
    WHERE memory_chunks_fts MATCH ?
      AND fts.group_folder = ?
    ORDER BY rank
    LIMIT ?
  `;
  return db.prepare(sql).all(query, groupFolder, limit) as MemorySearchResult[];
}

export function upsertMemoryChunk(chunk: MemoryChunk): void {
  const existing = db
    .prepare('SELECT id FROM memory_chunks WHERE id = ?')
    .get(chunk.id) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE memory_chunks SET content = ?, updated_at = ? WHERE id = ?`,
    ).run(chunk.content, chunk.updated_at, chunk.id);
    db.prepare(
      `UPDATE memory_chunks_fts SET content = ? WHERE chunk_id = ?`,
    ).run(chunk.content, chunk.id);
  } else {
    db.prepare(
      `INSERT INTO memory_chunks (id, group_folder, source_file, content, line_start, line_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      chunk.id,
      chunk.group_folder,
      chunk.source_file,
      chunk.content,
      chunk.line_start,
      chunk.line_end,
      chunk.created_at,
      chunk.updated_at,
    );
    db.prepare(
      `INSERT INTO memory_chunks_fts (content, group_folder, chunk_id)
       VALUES (?, ?, ?)`,
    ).run(chunk.content, chunk.group_folder, chunk.id);
  }
}

export function deleteMemoryChunksByFile(
  sourceFile: string,
  groupFolder: string,
): void {
  const chunks = db
    .prepare(
      'SELECT id FROM memory_chunks WHERE source_file = ? AND group_folder = ?',
    )
    .all(sourceFile, groupFolder) as Array<{ id: string }>;

  for (const chunk of chunks) {
    db.prepare('DELETE FROM memory_chunks_fts WHERE chunk_id = ?').run(
      chunk.id,
    );
  }
  db.prepare(
    'DELETE FROM memory_chunks WHERE source_file = ? AND group_folder = ?',
  ).run(sourceFile, groupFolder);
}
```

---

### Step 6: Create `src/memory-indexer.ts`

Create a new file `src/memory-indexer.ts`:

```typescript
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { GROUPS_DIR } from './config.js';
import {
  deleteMemoryChunksByFile,
  MemoryChunk,
  upsertMemoryChunk,
} from './db.js';
import { logger } from './logger.js';

const INDEX_INTERVAL = 30_000; // 30 seconds
const TARGET_CHUNK_TOKENS = 400;
const CHARS_PER_TOKEN = 4;
const TARGET_CHUNK_CHARS = TARGET_CHUNK_TOKENS * CHARS_PER_TOKEN;

const fileMtimes = new Map<string, number>();
let running = false;

export function startMemoryIndexer(): void {
  if (running) return;
  running = true;
  logger.info('Memory indexer started');
  indexLoop();
}

function indexLoop(): void {
  try {
    indexAllGroups();
  } catch (err) {
    logger.error({ err }, 'Memory indexer error');
  }
  setTimeout(indexLoop, INDEX_INTERVAL);
}

function indexAllGroups(): void {
  let groupDirs: string[];
  try {
    groupDirs = fs
      .readdirSync(GROUPS_DIR)
      .filter((f) => fs.statSync(path.join(GROUPS_DIR, f)).isDirectory());
  } catch {
    return;
  }

  for (const groupFolder of groupDirs) {
    const groupPath = path.join(GROUPS_DIR, groupFolder);
    const dirsToIndex = [
      path.join(groupPath, 'memory'),
      path.join(groupPath, 'conversations'),
    ];

    for (const dir of dirsToIndex) {
      if (!fs.existsSync(dir)) continue;
      indexDirectory(dir, groupFolder);
    }
  }
}

function indexDirectory(dir: string, groupFolder: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      indexDirectory(fullPath, groupFolder);
      continue;
    }

    if (!entry.name.endsWith('.md') && !entry.name.endsWith('.txt')) continue;

    try {
      const stat = fs.statSync(fullPath);
      const mtime = stat.mtimeMs;
      const cached = fileMtimes.get(fullPath);

      if (cached && cached >= mtime) continue;

      indexFile(fullPath, groupFolder);
      fileMtimes.set(fullPath, mtime);
    } catch {
      // file may have been deleted between readdir and stat
    }
  }
}

function indexFile(filePath: string, groupFolder: string): void {
  const content = fs.readFileSync(filePath, 'utf-8');
  if (!content.trim()) return;

  const sourceFile = path.relative(GROUPS_DIR, filePath);

  deleteMemoryChunksByFile(sourceFile, groupFolder);

  const chunks = chunkText(content);
  const now = new Date().toISOString();

  for (const chunk of chunks) {
    const id = crypto
      .createHash('sha256')
      .update(`${groupFolder}:${sourceFile}:${chunk.lineStart}:${chunk.lineEnd}`)
      .digest('hex')
      .slice(0, 16);

    const memChunk: MemoryChunk = {
      id,
      group_folder: groupFolder,
      source_file: sourceFile,
      content: chunk.text,
      line_start: chunk.lineStart,
      line_end: chunk.lineEnd,
      created_at: now,
      updated_at: now,
    };

    upsertMemoryChunk(memChunk);
  }

  logger.debug(
    { file: sourceFile, groupFolder, chunks: chunks.length },
    'Indexed memory file',
  );
}

interface TextChunk {
  text: string;
  lineStart: number;
  lineEnd: number;
}

function chunkText(content: string): TextChunk[] {
  const paragraphs = content.split(/\n\n+/);
  const chunks: TextChunk[] = [];
  let currentText = '';
  let currentLineStart = 1;
  let lineCounter = 1;

  for (const para of paragraphs) {
    const paraLines = para.split('\n').length;
    const paraStart = lineCounter;

    if (currentText.length + para.length > TARGET_CHUNK_CHARS && currentText) {
      chunks.push({
        text: currentText.trim(),
        lineStart: currentLineStart,
        lineEnd: lineCounter - 1,
      });
      currentText = '';
      currentLineStart = paraStart;
    }

    if (para.length > TARGET_CHUNK_CHARS * 1.5) {
      if (currentText) {
        chunks.push({
          text: currentText.trim(),
          lineStart: currentLineStart,
          lineEnd: paraStart - 1,
        });
        currentText = '';
      }

      const lines = para.split('\n');
      let subChunk = '';
      let subStart = paraStart;

      for (let i = 0; i < lines.length; i++) {
        if (subChunk.length + lines[i].length > TARGET_CHUNK_CHARS && subChunk) {
          chunks.push({
            text: subChunk.trim(),
            lineStart: subStart,
            lineEnd: paraStart + i - 1,
          });
          subChunk = '';
          subStart = paraStart + i;
        }
        subChunk += (subChunk ? '\n' : '') + lines[i];
      }

      if (subChunk.trim()) {
        chunks.push({
          text: subChunk.trim(),
          lineStart: subStart,
          lineEnd: paraStart + lines.length - 1,
        });
      }

      currentLineStart = paraStart + paraLines;
    } else {
      currentText += (currentText ? '\n\n' : '') + para;
    }

    lineCounter = paraStart + paraLines;
    lineCounter++;
  }

  if (currentText.trim()) {
    chunks.push({
      text: currentText.trim(),
      lineStart: currentLineStart,
      lineEnd: lineCounter - 1,
    });
  }

  return chunks;
}
```

---

### Step 7: Add memory_search IPC handler to `src/ipc.ts`

Read `src/ipc.ts`.

**7a.** Update the import from `./db.js` to also include `searchMemory`:

```typescript
import {
  createTask,
  deleteTask,
  getTaskById,
  searchMemory,
  updateTask,
} from './db.js';
```

**7b.** Inside `startIpcWatcher()`, in the `processIpcFiles` inner function, find the section that processes tasks (the `// Process tasks from this group's IPC directory` comment). **Before** that tasks section, add this block:

```typescript
// Process memory search requests
const memoryRequestsDir = path.join(
  ipcBaseDir,
  sourceGroup,
  'memory_requests',
);
try {
  if (fs.existsSync(memoryRequestsDir)) {
    const requestFiles = fs
      .readdirSync(memoryRequestsDir)
      .filter((f) => f.endsWith('.json'));
    for (const file of requestFiles) {
      const filePath = path.join(memoryRequestsDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);

        if (data.type === 'memory_search' && data.query) {
          const results = searchMemory(
            data.query,
            sourceGroup,
            data.limit || 5,
          );

          const resultsDir = path.join(
            ipcBaseDir,
            sourceGroup,
            'memory_results',
          );
          fs.mkdirSync(resultsDir, { recursive: true });
          const resultPath = path.join(
            resultsDir,
            `${data.requestId}.json`,
          );
          const tempPath = `${resultPath}.tmp`;
          fs.writeFileSync(
            tempPath,
            JSON.stringify({ results, requestId: data.requestId }),
          );
          fs.renameSync(tempPath, resultPath);

          logger.debug(
            {
              sourceGroup,
              query: data.query,
              resultCount: results.length,
            },
            'Memory search completed',
          );
        }
      } catch (err) {
        logger.error(
          { file, sourceGroup, err },
          'Error processing memory search request',
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
  }
} catch (err) {
  logger.error(
    { err, sourceGroup },
    'Error reading memory requests directory',
  );
}
```

---

### Step 8: Add `memory_search` MCP tool to container

Read `container/agent-runner/src/ipc-mcp-stdio.ts`. Before the `// Start the stdio transport` line at the bottom, add:

```typescript
server.tool(
  'memory_search',
  `Search your memory and past conversations. Returns relevant facts, decisions, and context from previous sessions.

Use this BEFORE answering questions about:
- Past conversations or events
- User preferences or decisions
- Previously discussed topics
- People, contacts, or relationships mentioned before

Don't guess from context -- search first if unsure.`,
  {
    query: z.string().describe('What to search for (use keywords, not full sentences)'),
    limit: z.number().optional().default(5).describe('Max results to return (default 5)'),
  },
  async (args) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestsDir = path.join(IPC_DIR, 'memory_requests');
    const resultsDir = path.join(IPC_DIR, 'memory_results');

    writeIpcFile(requestsDir, {
      type: 'memory_search',
      query: args.query,
      limit: args.limit || 5,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const resultPath = path.join(resultsDir, `${requestId}.json`);
    const timeout = 10_000;
    const pollInterval = 200;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (fs.existsSync(resultPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
          fs.unlinkSync(resultPath);

          if (!data.results || data.results.length === 0) {
            return {
              content: [{ type: 'text' as const, text: `No memories found for "${args.query}".` }],
            };
          }

          const formatted = data.results
            .map(
              (r: { content: string; source_file: string; rank: number }, i: number) =>
                `[${i + 1}] (${r.source_file})\n${r.content}`,
            )
            .join('\n\n---\n\n');

          return {
            content: [{ type: 'text' as const, text: `Found ${data.results.length} result(s) for "${args.query}":\n\n${formatted}` }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error reading search results: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return {
      content: [{ type: 'text' as const, text: 'Memory search timed out. The host may not be processing requests.' }],
      isError: true,
    };
  },
);
```

---

### Step 9: Wire up memory indexer in `src/index.ts`

Read `src/index.ts`.

**9a.** Add this import near the other imports:

```typescript
import { startMemoryIndexer } from './memory-indexer.js';
```

**9b.** In the `main()` function, find the line `queue.setProcessMessagesFn(processGroupMessages);` and add this line just before it:

```typescript
startMemoryIndexer();
```

---

### Step 10: Build and rebuild

Build the host:

```bash
npm run build
```

Rebuild the container:

```bash
./container/build.sh
```

If the container build fails with a buildkit cache issue, run:

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

Restart the service:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

---

## Verification

Tell the user:

> Memory system is installed! Here's how to verify:
>
> **Phase 1 (memory files):**
> - Send a message mentioning a preference (e.g., "I prefer morning meetings")
> - The agent should write it to `memory/facts.md` or `memory/daily/`
> - Trigger compaction (long conversation), verify daily log gets entries
> - Check that CLAUDE.md stays constant size
>
> **Phase 2 (search):**
> - Wait 30 seconds for the indexer to pick up the new memory files
> - Ask the agent something about your preference — it should use `memory_search` to find it
> - Check logs: `tail -f logs/nanoclaw.log | grep -i memory`

---

## What this changes

| File | Change |
|------|--------|
| `groups/global/CLAUDE.md` | Replace Memory section with Memory System conventions |
| `groups/main/CLAUDE.md` | Trim memory section, add pointer to global conventions |
| `src/index.ts` | Import and start memory indexer; create memory dirs on group registration |
| `src/db.ts` | Add `memory_chunks` + FTS5 tables, `searchMemory()`, `upsertMemoryChunk()`, `deleteMemoryChunksByFile()` |
| `src/memory-indexer.ts` | New file: polls memory/conversation files, chunks, indexes into FTS5 |
| `src/ipc.ts` | Add `memory_requests/` processing, write results to `memory_results/` |
| `container/agent-runner/src/index.ts` | Enhanced PreCompact hook extracts memory items into daily logs |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | New `memory_search` MCP tool |

## Future considerations

- **Semantic search:** Add embeddings via `text-embedding-3-small` for conceptual matches beyond keywords
- **Memory decay:** Importance scoring — frequently accessed memories get boosted, unused ones decay
- **Cross-group search:** Allow main group to search other groups' memories (read-only)
- **Weekly consolidation:** Scheduled task to extract facts from daily logs, resolve conflicts, prune old entries
