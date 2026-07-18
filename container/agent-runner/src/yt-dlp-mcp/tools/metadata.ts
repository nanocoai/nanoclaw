import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { fail, ok, runYtDlp, tailStderr } from '../spawn.js';
import { truncateForAi } from '../truncate.js';

interface VideoMetadata {
  id?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  view_count?: number;
  like_count?: number;
  upload_date?: string;
  description?: string;
  webpage_url?: string;
  thumbnail?: string;
  tags?: string[];
}

export const metadataTool: Tool = {
  name: 'ytdlp_get_metadata',
  description:
    'Fetch video metadata for a URL. Returns the full yt-dlp JSON by default, or a compact human-readable block if `summary: true`.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Video URL.' },
      summary: {
        type: 'boolean',
        description: 'Return a compact summary instead of full JSON. Default false.',
      },
      maxChars: {
        type: 'number',
        description: 'Truncate output above this many characters. Default 8000.',
      },
    },
    required: ['url'],
  },
};

export async function metadataHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const url = String(args.url ?? '').trim();
  if (!url) return fail('url is required');
  const summary = Boolean(args.summary ?? false);
  const maxChars = Math.max(500, Math.floor(Number(args.maxChars ?? 8000)));

  const result = await runYtDlp(
    ['--dump-single-json', '--no-playlist', '--no-warnings', url],
    { timeoutSec: 60 },
  );

  if (result.timedOut) return fail('yt-dlp metadata timed out');
  if (result.code !== 0) {
    return fail(`yt-dlp metadata failed (exit ${result.code}): ${tailStderr(result.stderr)}`);
  }

  let meta: VideoMetadata;
  try {
    meta = JSON.parse(result.stdout);
  } catch {
    return fail('yt-dlp returned invalid JSON');
  }

  const body = summary ? renderSummary(meta) : JSON.stringify(meta, null, 2);
  return ok(truncateForAi(body, maxChars));
}

function renderSummary(m: VideoMetadata): string {
  const channel = m.channel ?? m.uploader ?? '?';
  const dur = m.duration !== undefined ? `${Math.floor(m.duration / 60)}m ${Math.floor(m.duration % 60)}s` : '?';
  const views = m.view_count !== undefined ? m.view_count.toLocaleString('en-US') : '?';
  const likes = m.like_count !== undefined ? m.like_count.toLocaleString('en-US') : '?';
  const date = m.upload_date ?? '?';
  const desc = (m.description ?? '').trim().slice(0, 500);

  const lines = [
    `**${m.title ?? '(untitled)'}**`,
    `URL: ${m.webpage_url ?? '?'}`,
    `Channel: ${channel}`,
    `Duration: ${dur}`,
    `Views: ${views}  ·  Likes: ${likes}`,
    `Upload date: ${date}`,
  ];
  if (m.tags && m.tags.length > 0) {
    lines.push(`Tags: ${m.tags.slice(0, 10).join(', ')}`);
  }
  if (desc) {
    lines.push('', 'Description:', desc + (m.description!.length > 500 ? '…' : ''));
  }
  return lines.join('\n');
}
