import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { fail, okJson, runYtDlp, tailStderr } from '../spawn.js';

export const downloadAudioTool: Tool = {
  name: 'ytdlp_download_audio',
  description:
    'Download audio. First attempt (when format=mp3, the default): extract to mp3 (requires ffmpeg on PATH). Fallback on failure: best native audio (no transcoding) — typically m4a/webm/opus. Returns the saved file path; chain with mcp__nanoclaw__send_file to deliver.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Video URL.' },
      format: {
        type: 'string',
        enum: ['mp3', 'best'],
        description: 'mp3 (transcoded, needs ffmpeg) or best (native, no transcoding). Default mp3.',
      },
      outputDir: {
        type: 'string',
        description: 'Override output directory. Defaults to $YTDLP_DOWNLOADS_DIR or /tmp.',
      },
    },
    required: ['url'],
  },
};

export async function downloadAudioHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const url = String(args.url ?? '').trim();
  if (!url) return fail('url is required');
  const format = String(args.format ?? 'mp3');
  if (format !== 'mp3' && format !== 'best') {
    return fail(`Unsupported format: ${format}. Use mp3 | best.`);
  }
  const outputDir = String(args.outputDir ?? process.env.YTDLP_DOWNLOADS_DIR ?? '/tmp');

  if (format === 'best') {
    const r = await runDownload(url, outputDir, false);
    if (r.ok) return okJson({ path: r.path, format: 'native', container: extOf(r.path), fallback: false });
    return fail(`yt-dlp audio download failed: ${tailStderr(r.stderr)}`);
  }

  // mp3: try transcoding, fall back to native best on failure.
  const mp3 = await runDownload(url, outputDir, true);
  if (mp3.ok) return okJson({ path: mp3.path, format: 'mp3', container: 'mp3', fallback: false });

  const native = await runDownload(url, outputDir, false);
  if (native.ok) {
    return okJson({
      path: native.path,
      format: 'native',
      container: extOf(native.path),
      fallback: true,
      mp3_failure: tailStderr(mp3.stderr, 200),
    });
  }
  return fail(`yt-dlp audio download failed (mp3 + native both errored): ${tailStderr(native.stderr)}`);
}

interface RunSuccess { ok: true; path: string; }
interface RunFailure { ok: false; stderr: string; code: number; }

async function runDownload(
  url: string,
  outputDir: string,
  asMp3: boolean,
): Promise<RunSuccess | RunFailure> {
  const args = [
    '-f', 'bestaudio',
    '-o', `${outputDir}/yt-%(id)s.%(ext)s`,
    '--no-progress',
    '--no-warnings',
    '--no-playlist',
    '--print', 'after_move:filepath',
  ];
  if (asMp3) args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  args.push(url);

  const result = await runYtDlp(args, { timeoutSec: 900 });
  if (result.timedOut) return { ok: false, stderr: 'timed out', code: -1 };
  if (result.code !== 0) return { ok: false, stderr: result.stderr, code: result.code };

  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const path = lines[lines.length - 1] ?? '';
  if (!path) return { ok: false, stderr: 'no output filepath printed', code: 0 };
  return { ok: true, path };
}

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot + 1);
}
