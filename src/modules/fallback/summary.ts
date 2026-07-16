/**
 * Best-effort, host-side context summaries for the fallback switch/return
 * briefings. Both directions read from disk rather than calling a model —
 * the whole point is to work even when the model that would normally
 * summarize (Claude) is the one that's down.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { openOutboundDb } from '../../session-manager.js';
import { log } from '../../log.js';

const MAX_SUMMARY_CHARS = 4000;
const MAX_PAIRS = 10;

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Node port of providers/claude.ts's parseTranscript — same .jsonl shape. */
function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

function findTranscriptPath(agentGroupId: string, claudeSessionId: string): string | null {
  const projects = path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'projects');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projects, dir, `${claudeSessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Reads the Claude SDK session id the poll-loop stored as its continuation token. */
function readClaudeContinuation(agentGroupId: string, sessionId: string): string | null {
  try {
    const outDb = openOutboundDb(agentGroupId, sessionId);
    try {
      const row = outDb.prepare("SELECT value FROM session_state WHERE key = 'continuation:claude'").get() as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    } finally {
      outDb.close();
    }
  } catch {
    return null;
  }
}

function renderSummary(messages: ParsedMessage[]): string {
  const recent = messages.slice(-MAX_PAIRS * 2);
  const joined = recent.map((m) => `**${m.role === 'user' ? 'User' : 'Assistant'}**: ${m.content}`).join('\n');
  return joined.length > MAX_SUMMARY_CHARS ? `${joined.slice(0, MAX_SUMMARY_CHARS)}...` : joined;
}

/**
 * Forward ("outgoing") briefing: last ~10 exchanges from Claude's own .jsonl
 * transcript, read directly off the `.claude-shared` mount — never calls the
 * (possibly limit-hit) Claude model itself. Returns null on any failure or
 * if there's nothing to summarize.
 */
export function summarizeClaudeTranscript(agentGroupId: string, sessionId: string): string | null {
  const claudeSessionId = readClaudeContinuation(agentGroupId, sessionId);
  if (!claudeSessionId) return null;
  const transcriptPath = findTranscriptPath(agentGroupId, claudeSessionId);
  if (!transcriptPath) return null;
  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);
    if (messages.length === 0) return null;
    return renderSummary(messages);
  } catch (err) {
    log.warn('Failed to read Claude transcript for fallback summary', { agentGroupId, sessionId, err });
    return null;
  }
}

/**
 * Return ("return") briefing: markdown files the backup provider archived
 * into its `conversations/` folder while Claude was down (mtime >=
 * `enteredAt`). Providers with no on-disk transcript of their own rely on
 * `onExchangeComplete` writing there directly (see providers/types.ts).
 */
export function summarizeBackupConversation(agentGroupId: string, enteredAt: string | null): string | null {
  if (!enteredAt) return null;
  const group = getAgentGroup(agentGroupId);
  if (!group) return null;

  const conversationsDir = path.join(GROUPS_DIR, group.folder, 'conversations');
  let files: string[];
  try {
    files = fs.readdirSync(conversationsDir);
  } catch {
    return null;
  }

  const sinceMs = Date.parse(enteredAt);
  const relevant = files
    .map((f) => {
      const p = path.join(conversationsDir, f);
      try {
        return { path: p, mtimeMs: fs.statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(
      (f): f is { path: string; mtimeMs: number } => f !== null && (Number.isNaN(sinceMs) || f.mtimeMs >= sinceMs),
    )
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  if (relevant.length === 0) return null;

  const chunks: string[] = [];
  for (const f of relevant) {
    try {
      chunks.push(fs.readFileSync(f.path, 'utf-8'));
    } catch {
      /* skip unreadable file */
    }
  }
  if (chunks.length === 0) return null;
  const joined = chunks.join('\n\n---\n\n');
  return joined.length > MAX_SUMMARY_CHARS ? `${joined.slice(0, MAX_SUMMARY_CHARS)}...` : joined;
}
