/**
 * Claude-owned transcript history: the pre-compact archive, continuation
 * rotation, and the newest-trace lookup. All of it reads the Claude Agent
 * SDK's on-disk `.jsonl` transcripts, so it belongs to this provider and is
 * not part of the runtime contract — ClaudeProvider calls the archive from its
 * PreCompact hook and the rotation from `maybeRotateContinuation`; only
 * `newestClaudeTranscript` is declared on the contract (`history.readTrace`).
 *
 * The functions take a clock instead of reading `Date.now()` themselves so
 * tests can pin the archive name and header.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { TIMEZONE, formatLocalStamp } from '../timezone.js';

export interface ClaudeHistoryClock {
  now(): number;
}

export interface ClaudeArchiveInput {
  transcriptPath?: string;
  sessionId?: string;
  assistantName?: string;
  log(message: string): void;
}

export interface ClaudeContinuationRotationInput {
  continuation: string;
  assistantName?: string;
  log(message: string): void;
}

interface ClaudeArchivePlan {
  relativePath: string;
  content: string;
  write: 'replace' | 'append';
  headerIfNew?: string;
}

interface ClaudeContinuationRotationDecision {
  reason?: string;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** `CLAUDE_CONFIG_DIR` or `~/.claude`: where the SDK keeps settings.json and project transcripts. */
export function claudeConfigDirectory(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
}

/** The newest SDK transcript under `~/.claude/projects`, for `/upload-trace`. */
export function newestClaudeTranscript(): string | null {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let best: { path: string; mtimeMs: number } | null = null;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(path.join(projects, dir));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const candidate = path.join(projects, dir, file);
      const mtimeMs = fs.statSync(candidate).mtimeMs;
      if (!best || mtimeMs > best.mtimeMs) best = { path: candidate, mtimeMs };
    }
  }
  return best?.path ?? null;
}

/** Archive a transcript as markdown into the conversations directory. Never throws. */
export function archiveClaudeTranscript(input: ClaudeArchiveInput, fx: ClaudeHistoryClock): boolean {
  if (!input.transcriptPath || !fs.existsSync(input.transcriptPath)) {
    input.log('No transcript found for archiving');
    return false;
  }

  try {
    const transcriptContent = fs.readFileSync(input.transcriptPath, 'utf-8');
    const indexPath = path.join(path.dirname(input.transcriptPath), 'sessions-index.json');
    let sessionsIndexContent: string | undefined;
    if (fs.existsSync(indexPath)) {
      try {
        sessionsIndexContent = fs.readFileSync(indexPath, 'utf-8');
      } catch {
        // Existing behavior ignores unreadable session indexes.
      }
    }
    const plan = planTranscriptArchive(
      { transcriptContent, sessionsIndexContent, sessionId: input.sessionId, assistantName: input.assistantName },
      fx,
    );
    if (!plan) return false;

    const conversationsDir = process.env.NANOCLAW_CONVERSATIONS_DIR || '/workspace/agent/conversations';
    const target = resolveContainedPath(conversationsDir, plan.relativePath, 'Archive planner returned unsafe path');
    fs.mkdirSync(conversationsDir, { recursive: true });
    writeArchivePlan(target, plan);
    input.log(`Archived conversation to ${plan.relativePath}`);
    return true;
  } catch (error) {
    input.log(`Failed to archive transcript: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function planTranscriptArchive(
  input: {
    transcriptContent: string;
    sessionsIndexContent?: string;
    sessionId?: string;
    assistantName?: string;
  },
  fx: ClaudeHistoryClock,
): ClaudeArchivePlan | null {
  const messages = parseTranscript(input.transcriptContent);
  if (messages.length === 0) return null;

  let summary: string | undefined;
  if (input.sessionsIndexContent) {
    try {
      const index = JSON.parse(input.sessionsIndexContent);
      summary = index.entries?.find(
        (entry: { sessionId: string; summary?: string }) => entry.sessionId === input.sessionId,
      )?.summary;
    } catch {
      // Existing behavior ignores malformed session indexes.
    }
  }

  const name = summary
    ? summary
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50)
    : `conversation-${new Date(fx.now()).getHours().toString().padStart(2, '0')}${new Date(fx.now())
        .getMinutes()
        .toString()
        .padStart(2, '0')}`;
  const filenameDate = new Date(fx.now());
  const headerDate = new Date(fx.now());
  return {
    relativePath: `${formatLocalStamp(filenameDate, TIMEZONE).slice(0, 10)}-${name}.md`,
    content: formatTranscriptMarkdown(messages, summary, input.assistantName, headerDate),
    write: 'replace',
  };
}

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
            : entry.message.content.map((part: { text?: string }) => part.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const text = entry.message.content
          .filter((part: { type: string }) => part.type === 'text')
          .map((part: { text: string }) => part.text)
          .join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // Existing behavior skips malformed transcript lines.
    }
  }
  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title: string | undefined,
  assistantName: string | undefined,
  now: Date,
): string {
  const date = now.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${date}`, '', '---', ''];
  for (const message of messages) {
    const sender = message.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = message.content.length > 2000 ? `${message.content.slice(0, 2000)}...` : message.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

/**
 * Before resuming, drop a transcript that has grown too large or too old to
 * cold-resume within the host's idle ceiling. Archives what it can, moves the
 * `.jsonl` aside, and returns the reason; null keeps resuming.
 */
export function rotateClaudeContinuation(
  input: ClaudeContinuationRotationInput,
  fx: ClaudeHistoryClock,
): string | null {
  const transcriptPath = findContinuationFile(
    path.join(claudeConfigDirectory(), 'projects'),
    `${input.continuation}.jsonl`,
  );
  if (!transcriptPath) return null;

  try {
    const size = fs.statSync(transcriptPath).size;
    let firstLine = '';
    try {
      firstLine = readFirstLine(transcriptPath);
    } catch {
      // Size-only rotation must survive an unreadable first entry.
    }
    const decision = decideContinuationRotation({ size, firstLine }, fx);
    if (!decision?.reason) return null;

    archiveClaudeTranscript(
      {
        transcriptPath,
        sessionId: input.continuation,
        assistantName: input.assistantName,
        log: input.log,
      },
      fx,
    );
    try {
      fs.renameSync(transcriptPath, `${transcriptPath}.rotated-${fx.now()}`);
    } catch (error) {
      input.log(`Failed to move rotated transcript aside: ${error instanceof Error ? error.message : String(error)}`);
    }
    return decision.reason;
  } catch {
    return null;
  }
}

function decideContinuationRotation(
  input: { size: number; firstLine: string },
  fx: ClaudeHistoryClock,
): ClaudeContinuationRotationDecision | null {
  const maxBytes = Number(process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES) || 12 * 1024 * 1024;
  const rawDays = process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS;
  const days = rawDays === undefined || rawDays.trim() === '' ? 14 : Number(rawDays);
  const maxAgeMs = !Number.isFinite(days) ? 14 * 86_400_000 : days > 0 ? days * 86_400_000 : Infinity;
  let startMs: number | null = null;
  try {
    const timestamp = JSON.parse(input.firstLine)?.timestamp;
    const parsed = timestamp ? Date.parse(timestamp) : NaN;
    if (!Number.isNaN(parsed)) startMs = parsed;
  } catch {
    // Existing behavior ignores unreadable first entries.
  }

  const ageMs = startMs === null ? 0 : fx.now() - startMs;
  if (input.size > maxBytes) {
    return {
      reason: `transcript ${(input.size / 1_048_576).toFixed(1)}MB > ${(maxBytes / 1_048_576).toFixed(0)}MB cap`,
    };
  }
  if (startMs !== null && ageMs > maxAgeMs) {
    return {
      reason: `transcript ${(ageMs / 86_400_000).toFixed(1)}d old > ${(maxAgeMs / 86_400_000).toFixed(0)}d cap`,
    };
  }
  return null;
}

function findContinuationFile(root: string, fileName: string): string | null {
  let directories: string[];
  try {
    directories = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const directory of directories) {
    const candidate = path.join(root, directory, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readFirstLine(filePath: string): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString('utf-8', 0, bytes).split('\n', 1)[0];
  } finally {
    fs.closeSync(fd);
  }
}

function writeArchivePlan(filePath: string, plan: ClaudeArchivePlan): void {
  if (plan.write === 'replace') {
    fs.writeFileSync(filePath, plan.content);
    return;
  }
  const header = plan.headerIfNew && !fs.existsSync(filePath) ? plan.headerIfNew : '';
  fs.appendFileSync(filePath, `${header}${plan.content}`);
}

function resolveContainedPath(root: string, relativePath: string, errorPrefix: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${errorPrefix} '${relativePath}'`);
  }
  return target;
}
