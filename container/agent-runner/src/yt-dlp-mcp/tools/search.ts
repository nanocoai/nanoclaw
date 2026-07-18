import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { fail, ok, runYtDlp, tailStderr } from '../spawn.js';
import { truncateForAi } from '../truncate.js';

interface SearchEntry {
  id?: string;
  title?: string;
  url?: string;
  webpage_url?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  view_count?: number;
  upload_date?: string;
}

export const searchTool: Tool = {
  name: 'ytdlp_search',
  description:
    'Search YouTube with pagination and optional filters. Returns markdown by default; pass `format: "json"` for structured entries.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
      page: { type: 'number', description: '1-based page number. Default 1.' },
      pageSize: { type: 'number', description: 'Results per page (max 25). Default 10.' },
      sortBy: {
        type: 'string',
        enum: ['relevance', 'date', 'views'],
        description: 'Sort order. Default relevance (yt-dlp native order).',
      },
      minDuration: { type: 'number', description: 'Minimum duration in seconds.' },
      maxDuration: { type: 'number', description: 'Maximum duration in seconds.' },
      minViews: { type: 'number', description: 'Minimum view count.' },
      format: {
        type: 'string',
        enum: ['md', 'json'],
        description: 'Output format. Default md.',
      },
      maxChars: {
        type: 'number',
        description: 'Truncate output above this many characters. Default 8000.',
      },
    },
    required: ['query'],
  },
};

export async function searchHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const query = String(args.query ?? '').trim();
  if (!query) return fail('query is required');

  const page = Math.max(1, Math.floor(Number(args.page ?? 1)));
  const pageSize = Math.min(25, Math.max(1, Math.floor(Number(args.pageSize ?? 10))));
  const sortBy = String(args.sortBy ?? 'relevance');
  const minDuration = num(args.minDuration);
  const maxDuration = num(args.maxDuration);
  const minViews = num(args.minViews);
  const format = String(args.format ?? 'md');
  const maxChars = Math.max(500, Math.floor(Number(args.maxChars ?? 8000)));

  // Fetch enough to cover up to and including the requested page, then slice.
  const fetchN = page * pageSize;
  const result = await runYtDlp(
    ['--flat-playlist', '--dump-single-json', `ytsearch${fetchN}:${query}`],
    { timeoutSec: 60 },
  );

  if (result.timedOut) return fail('yt-dlp search timed out');
  if (result.code !== 0) {
    return fail(`yt-dlp search failed (exit ${result.code}): ${tailStderr(result.stderr)}`);
  }

  let parsed: { entries?: SearchEntry[] };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return fail('yt-dlp returned invalid JSON');
  }

  let entries = parsed.entries ?? [];

  entries = entries.filter((e) => {
    if (minDuration !== undefined && (e.duration ?? 0) < minDuration) return false;
    if (maxDuration !== undefined && (e.duration ?? Number.POSITIVE_INFINITY) > maxDuration) return false;
    if (minViews !== undefined && (e.view_count ?? 0) < minViews) return false;
    return true;
  });

  if (sortBy === 'views') {
    entries = entries.slice().sort((a, b) => (b.view_count ?? 0) - (a.view_count ?? 0));
  } else if (sortBy === 'date') {
    entries = entries.slice().sort((a, b) => (b.upload_date ?? '').localeCompare(a.upload_date ?? ''));
  }

  const start = (page - 1) * pageSize;
  const sliced = entries.slice(start, start + pageSize);

  const body = format === 'json'
    ? JSON.stringify({ page, pageSize, total: entries.length, entries: sliced }, null, 2)
    : renderMd(sliced, page, pageSize, entries.length);

  return ok(truncateForAi(body, maxChars));
}

function renderMd(entries: SearchEntry[], page: number, pageSize: number, total: number): string {
  if (entries.length === 0) return '_No results._';
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const lines = [
    `**Search results — page ${page}/${totalPages} (${total} after filters)**`,
    '',
  ];
  for (const e of entries) {
    const url = e.webpage_url ?? e.url ?? (e.id ? `https://youtu.be/${e.id}` : '');
    const dur = e.duration !== undefined ? formatDuration(e.duration) : '?';
    const views = e.view_count !== undefined ? formatViews(e.view_count) : '?';
    const date = e.upload_date ? formatDate(e.upload_date) : '?';
    const channel = e.channel ?? e.uploader ?? '?';
    lines.push(`- [${e.title ?? '(untitled)'}](${url}) — ${channel} · ${dur} · ${views} views · ${date}`);
  }
  return lines.join('\n');
}

function formatDuration(s: number): string {
  const total = Math.floor(s);
  const secs = (total % 60).toString().padStart(2, '0');
  const mins = Math.floor(total / 60);
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = (mins % 60).toString().padStart(2, '0');
    return `${h}:${m}:${secs}`;
  }
  return `${mins}:${secs}`;
}

function formatViews(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

function formatDate(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
