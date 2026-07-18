import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { fail, okJson, runYtDlp, tailStderr } from '../spawn.js';

const RESOLUTION_HEIGHT: Record<string, number | undefined> = {
  '480p': 480,
  '720p': 720,
  '1080p': 1080,
  best: undefined,
};

const CODEC_VFILTER: Record<string, string> = {
  h264: '[vcodec~="^avc1"]',
  h265: '[vcodec~="^(hev1|hvc1)"]',
  av1: '[vcodec~="^av01"]',
  vp9: '[vcodec~="^(vp9|vp09)"]',
  any: '',
};

export const downloadVideoTool: Tool = {
  name: 'ytdlp_download_video',
  description:
    'Download a video. First attempt: mp4 with the requested codec (default H.264 for broad playback compatibility). Fallback on failure: best quality available in any container/codec. Returns the saved file path; chain with mcp__nanoclaw__send_file to deliver.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Video URL.' },
      resolution: {
        type: 'string',
        enum: ['480p', '720p', '1080p', 'best'],
        description: 'Max height. Default best.',
      },
      codec: {
        type: 'string',
        enum: ['h264', 'h265', 'av1', 'vp9', 'any'],
        description:
          'Preferred video codec. Default h264 (avc1) — widest playback compatibility (QuickTime, iOS, WhatsApp, etc.). Use "any" to skip codec filtering.',
      },
      outputDir: {
        type: 'string',
        description: 'Override output directory. Defaults to $YTDLP_DOWNLOADS_DIR or /tmp.',
      },
      trim: {
        type: 'object',
        description: 'Optional segment to download.',
        properties: {
          start: { type: 'number', description: 'Start in seconds.' },
          end: { type: 'number', description: 'End in seconds.' },
        },
        required: ['start', 'end'],
      },
    },
    required: ['url'],
  },
};

export async function downloadVideoHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const url = String(args.url ?? '').trim();
  if (!url) return fail('url is required');
  const resolution = String(args.resolution ?? 'best');
  if (!(resolution in RESOLUTION_HEIGHT)) {
    return fail(`Unsupported resolution: ${resolution}. Use 480p | 720p | 1080p | best.`);
  }
  const codec = String(args.codec ?? 'h264');
  if (!(codec in CODEC_VFILTER)) {
    return fail(`Unsupported codec: ${codec}. Use h264 | h265 | av1 | vp9 | any.`);
  }
  const outputDir = String(args.outputDir ?? process.env.YTDLP_DOWNLOADS_DIR ?? '/tmp');
  const trim = parseTrim(args.trim);
  if (trim && 'error' in trim) return fail(trim.error);

  const height = RESOLUTION_HEIGHT[resolution];
  const heightFilter = height ? `[height<=${height}]` : '';
  const codecFilter = CODEC_VFILTER[codec];
  const mp4Format = `bv*[ext=mp4]${codecFilter}${heightFilter}+ba[ext=m4a]/b[ext=mp4]${codecFilter}${heightFilter}`;
  const fallbackFormat = height ? `bv*${heightFilter}+ba/b${heightFilter}` : 'bv*+ba/b';

  // First attempt: mp4 container.
  const mp4 = await runDownload(url, mp4Format, outputDir, true, trim ?? undefined);
  if (mp4.ok) {
    return okJson({ path: mp4.path, format: 'mp4', codec, container: extOf(mp4.path), fallback: false });
  }

  // Fallback: best quality, any container/codec.
  const best = await runDownload(url, fallbackFormat, outputDir, false, trim ?? undefined);
  if (best.ok) {
    return okJson({
      path: best.path,
      format: 'best',
      container: extOf(best.path),
      fallback: true,
      mp4_failure: tailStderr(mp4.stderr, 200),
    });
  }
  return fail(`yt-dlp download failed (mp4 + fallback both errored): ${tailStderr(best.stderr)}`);
}

interface RunSuccess { ok: true; path: string; }
interface RunFailure { ok: false; stderr: string; code: number; }

async function runDownload(
  url: string,
  format: string,
  outputDir: string,
  mergeMp4: boolean,
  trim: { start: number; end: number } | undefined,
): Promise<RunSuccess | RunFailure> {
  const args = [
    '-f', format,
    '-o', `${outputDir}/yt-%(id)s.%(ext)s`,
    '--no-progress',
    '--no-warnings',
    '--no-playlist',
    '--print', 'after_move:filepath',
  ];
  if (mergeMp4) args.push('--merge-output-format', 'mp4');
  if (trim) args.push('--download-sections', `*${trim.start}-${trim.end}`);
  args.push(url);

  const result = await runYtDlp(args, { timeoutSec: 1800 });
  if (result.timedOut) return { ok: false, stderr: 'timed out', code: -1 };
  if (result.code !== 0) return { ok: false, stderr: result.stderr, code: result.code };

  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const path = lines[lines.length - 1] ?? '';
  if (!path) return { ok: false, stderr: 'no output filepath printed', code: 0 };
  return { ok: true, path };
}

function parseTrim(raw: unknown): { start: number; end: number } | { error: string } | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') return { error: 'trim must be an object {start, end}' };
  const t = raw as Record<string, unknown>;
  const start = Number(t.start);
  const end = Number(t.end);
  if (!Number.isFinite(start) || start < 0) return { error: 'trim.start must be >= 0' };
  if (!Number.isFinite(end) || end <= start) return { error: 'trim.end must be > trim.start' };
  return { start, end };
}

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot + 1);
}
