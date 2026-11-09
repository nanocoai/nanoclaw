import fs from 'fs';
import path from 'path';

import { TIMEZONE, formatLocalStamp } from '../timezone.js';

/**
 * Per-thread conversation archive for providers whose harness keeps no
 * on-disk transcript. A runtime contract's `history.afterExchange` calls
 * `archiveProviderExchange`; the plan is pure, so every caller writes the
 * same format.
 *
 * One file per thread (keyed on the continuation id), named
 * `<date>-<provider>-<thread>.md` and appended to as exchanges complete. The
 * date is the thread's creation day and stays stable across later appends.
 */

const DEFAULT_CONVERSATIONS_DIR = '/workspace/agent/conversations';

export interface ProviderExchangeArchiveOptions {
  provider: string;
  prompt: string;
  result: string | null | undefined;
  continuation?: string;
  status: string;
  timestamp?: Date;
  conversationsDir?: string;
}

export interface ProviderExchangeArchivePlan {
  relativePath: string;
  content: string;
  write: 'append';
  /** Thread-level header, written once by whoever creates the file. */
  headerIfNew?: string;
}

export interface ProviderExchangeArchivePlanInput {
  provider: string;
  prompt: string;
  result: string | null | undefined;
  continuation?: string;
  status: string;
  timestamp: Date;
  entries: readonly string[];
}

/**
 * Append one prompt/result exchange to its thread's file, writing the header
 * when the file is new. Returns the thread-stable filename, or null when the
 * result is empty.
 */
export function archiveProviderExchange(options: ProviderExchangeArchiveOptions): string | null {
  if (!options.result?.trim()) return null;
  const timestamp = options.timestamp ?? new Date();
  const conversationsDir =
    options.conversationsDir || process.env.NANOCLAW_CONVERSATIONS_DIR || DEFAULT_CONVERSATIONS_DIR;
  let entries: readonly string[] = [];
  try {
    entries = fs.readdirSync(conversationsDir);
  } catch {
    // First archive for this workspace: nothing to continue.
  }
  const plan = planProviderExchangeArchive({ ...options, timestamp, entries });
  if (!plan) return null;

  fs.mkdirSync(conversationsDir, { recursive: true });
  const filePath = path.join(conversationsDir, plan.relativePath);
  const header = plan.headerIfNew && !fs.existsSync(filePath) ? plan.headerIfNew : '';
  fs.appendFileSync(filePath, `${header}${plan.content}`);
  return plan.relativePath;
}

export function planProviderExchangeArchive(
  options: ProviderExchangeArchivePlanInput,
): ProviderExchangeArchivePlan | null {
  const result = options.result?.trim();
  if (!result) return null;

  const filename = threadArchiveFilename(options.entries, options.provider, options.continuation, options.timestamp);

  // Thread metadata goes in the header, written once; per-exchange metadata
  // rides in each block. The leading blank line keeps `---` a thematic break
  // rather than a setext underline on the previous line.
  const headerIfNew = [
    `# ${titleCase(options.provider)} Conversation`,
    '',
    `Provider: ${options.provider}`,
    `Continuation/thread id: ${options.continuation || '(none)'}`,
    '',
  ].join('\n');
  const parts: string[] = [];
  parts.push(
    '',
    '---',
    '',
    `Archived: ${formatLocalStamp(options.timestamp, TIMEZONE)} · Status: ${options.status}`,
    '',
    `**User**: ${truncate(options.prompt)}`,
    '',
    `**Assistant**: ${truncate(result)}`,
    '',
  );
  return { relativePath: filename, content: parts.join('\n'), write: 'append', headerIfNew };
}

function threadArchiveFilename(
  entries: readonly string[],
  provider: string,
  continuation: string | undefined,
  timestamp: Date,
): string {
  const thread = sanitizeSlug(continuation || 'no-thread').slice(0, 48) || 'no-thread';
  const suffix = `${sanitizeSlug(provider)}-${thread}.md`;
  // Reuse the thread's file whatever day it was created; match on the part
  // after the date prefix.
  const dated = /^\d{4}-\d{2}-\d{2}-/;
  const existing = entries.find((file) => dated.test(file) && file.replace(dated, '') === suffix);
  if (existing) return existing;
  // Local calendar day, so evening sessions west of UTC keep today's date.
  return `${formatLocalStamp(timestamp, TIMEZONE).slice(0, 10)}-${suffix}`;
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleCase(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : 'Provider';
}

function truncate(value: string): string {
  return value.length > 2000 ? value.slice(0, 2000) + '...' : value;
}
