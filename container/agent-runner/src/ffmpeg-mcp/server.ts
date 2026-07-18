/**
 * ffmpeg MCP server — wraps `ffmpeg` and `ffprobe` as a stdio MCP server.
 *
 * Lives outside the built-in `nanoclaw` MCP server so it follows the same
 * per-group opt-in pattern as gmail/ollama: a group enables ffmpeg by adding
 * an `mcpServers.ffmpeg` entry to its `container.json`. The tool-allowlist
 * pattern (`mcp__ffmpeg__*`) is auto-derived from that map by `claude.ts`.
 *
 * Tool surface (curated, not a 1:1 ffmpeg wrapper):
 *   probe          — ffprobe metadata
 *   convert        — change container/codec format
 *   trim           — extract a [start, start+duration) segment
 *   extract_audio  — strip audio track from a video
 *   compress       — re-encode for size (CRF or target MB)
 *
 * Streaming, filtergraphs, watermark/overlay, and DRM are intentionally
 * out of scope. The agent chains tool output → mcp__nanoclaw__send_file
 * to deliver results back to the channel.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

// Workspace root is hardcoded for the container; tests can override via
// NANOCLAW_FFMPEG_WORKSPACE_ROOT to stage fixtures in a tmp dir instead.
function workspaceRoot(): string {
  return process.env.NANOCLAW_FFMPEG_WORKSPACE_ROOT || '/workspace';
}
// Output dir for tool products. Defaults to /tmp, which is container-internal
// (not bind-mounted) — so outputs auto-clean on container exit and don't
// accumulate on the host. Tests override via NANOCLAW_FFMPEG_TMP_DIR to a
// staged path so they can stage files without touching the real /tmp.
function tmpDir(): string {
  return process.env.NANOCLAW_FFMPEG_TMP_DIR || '/tmp';
}
const DEFAULT_TIMEOUT_SEC = Number(process.env.NANOCLAW_FFMPEG_TIMEOUT_SEC) || 300;
// Per-call timeout ceiling. The lower bound of 1800s is the policy default;
// if an operator deliberately raised the global default above 1800 we honor
// that as the new ceiling — otherwise an agent could never opt into the same
// budget the operator already permitted.
const MAX_TIMEOUT_SEC = Math.max(1800, DEFAULT_TIMEOUT_SEC);
const MIN_TIMEOUT_SEC = 5;
const STDERR_TAIL_BYTES = 2048;

// Tmp file lifecycle:
//   - Each tool writes its output under tmpDir() (`/tmp` by default —
//     container-internal, not bind-mounted).
//   - The agent then calls `mcp__nanoclaw__send_file` on that path. send_file
//     copies the bytes into /workspace/outbox/<msg-id>/, where delivery picks
//     them up. Once that copy succeeds, the original tmp file is no longer
//     needed — keeping it around just doubles disk usage.
//   - This server reaps tmp files older than TMP_TTL_MS on a periodic timer.
//     The TTL is generous enough that an in-flight send_file (called right
//     after the tool returned) always wins the race. The sweep is still
//     useful within a long-lived container even though `--rm` cleans /tmp
//     on exit, since chains like trim → compress → extract_audio can
//     accumulate intermediate files within a single session.
const TMP_TTL_MS = (Number(process.env.NANOCLAW_FFMPEG_TMP_TTL_SEC) || 900) * 1000;
const TMP_SWEEP_INTERVAL_MS = (Number(process.env.NANOCLAW_FFMPEG_TMP_SWEEP_SEC) || 300) * 1000;

// Single source of truth: every supported output extension and its MIME.
// OUTPUT_EXT_WHITELIST and AUDIO_ONLY_EXTS are derived so they can't drift.
const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/opus',
  gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
};
const OUTPUT_EXT_WHITELIST = new Set(Object.keys(MIME_BY_EXT));
const AUDIO_ONLY_EXTS = new Set(
  Object.entries(MIME_BY_EXT).filter(([, m]) => m.startsWith('audio/')).map(([e]) => e),
);

// Operator-facing logging. Captured via the container stderr pipe and surfaced
// in logs/nanoclaw.log; user-facing errors are kept terser via fail().
function logErr(tool: string, reason: string, extra?: Record<string, unknown>): void {
  const detail = extra ? ' ' + JSON.stringify(extra) : '';
  console.error(`[ffmpeg-mcp] ${tool}: ${reason}${detail}`);
}
function logInfo(msg: string): void {
  console.error(`[ffmpeg-mcp] ${msg}`);
}

function ok(payload: object): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...payload }) }] };
}
function fail(tool: string, error: string, logExtra?: Record<string, unknown>): CallToolResult {
  logErr(tool, error, logExtra);
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error }) }], isError: true };
}

// Resolve an input path: accepts absolute paths under /workspace, absolute
// paths under tmpDir() (so chained tool→tool calls can re-read prior
// outputs), or paths relative to /workspace/agent. Rejects `..` or symlink
// escapes — realpath is the source of truth.
function resolveInputPath(input: string): { path: string } | { error: string } {
  if (!input || typeof input !== 'string') return { error: 'input path is required' };
  const candidate = path.isAbsolute(input) ? input : path.resolve('/workspace/agent', input);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return { error: `Input not found: ${input}` };
  }
  const allowedRoots = [workspaceRoot(), tmpDir()];
  const inAllowedRoot = allowedRoots.some(
    (root) => real === root || real.startsWith(root + path.sep),
  );
  if (!inAllowedRoot) {
    return { error: 'Input path must live under /workspace or /tmp' };
  }
  if (!fs.statSync(real).isFile()) {
    return { error: 'Input path is not a regular file' };
  }
  return { path: real };
}

function validateOutputExt(ext: string): string | null {
  const clean = ext.toLowerCase().replace(/^\./, '');
  if (!OUTPUT_EXT_WHITELIST.has(clean)) return null;
  return clean;
}

function mimeFor(ext: string): string {
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function makeOutputPath(ext: string): string {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `ffmpeg-${randomUUID()}.${ext}`);
}

// Spawn layer (injectable for tests).

export interface RunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export type SpawnFn = (cmd: string, args: string[], timeoutSec: number) => Promise<RunResult>;

async function defaultSpawn(cmd: string, args: string[], timeoutSec: number): Promise<RunResult> {
  const proc = Bun.spawn([cmd, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill('SIGKILL'); } catch { /* already exited */ }
  }, timeoutSec * 1000);

  const [stdout, stderrFull, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  const stderr = stderrFull.length > STDERR_TAIL_BYTES
    ? '...' + stderrFull.slice(-STDERR_TAIL_BYTES)
    : stderrFull;

  return { exitCode, stderr, stdout, timedOut };
}

let _spawn: SpawnFn = defaultSpawn;

/** Test-only: swap the spawn implementation. */
export function __setSpawnForTesting(fn: SpawnFn | null): void {
  _spawn = fn ?? defaultSpawn;
}

async function runFfmpeg(args: string[], timeoutSec: number = DEFAULT_TIMEOUT_SEC): Promise<RunResult> {
  return _spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], timeoutSec);
}

async function runFfprobe(args: string[], timeoutSec: number = DEFAULT_TIMEOUT_SEC): Promise<RunResult> {
  return _spawn('ffprobe', ['-hide_banner', '-loglevel', 'error', ...args], timeoutSec);
}

// Validate + clamp an optional per-call `timeout_seconds`.
function resolveTimeoutSec(raw: unknown): number | { error: string } {
  if (raw === undefined || raw === null) return DEFAULT_TIMEOUT_SEC;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return { error: 'timeout_seconds must be a positive number' };
  }
  if (n < MIN_TIMEOUT_SEC) {
    return { error: `timeout_seconds must be >= ${MIN_TIMEOUT_SEC}` };
  }
  if (n > MAX_TIMEOUT_SEC) {
    return { error: `timeout_seconds must be <= ${MAX_TIMEOUT_SEC}` };
  }
  return Math.floor(n);
}

// Shared schema partials + the `input` + `timeout_seconds` validator that
// every non-probe tool runs first.
const INPUT_PROP = {
  type: 'string' as const,
  description: 'Path to the source file (absolute under /workspace, or relative to /workspace/agent).',
};
const TIMEOUT_PROP = {
  type: 'number' as const,
  description: `Optional per-call timeout in seconds (${MIN_TIMEOUT_SEC}–${MAX_TIMEOUT_SEC}, default ${DEFAULT_TIMEOUT_SEC}). The ffmpeg process is killed on expiry.`,
};

function resolveInputAndTimeout(
  tool: string,
  args: Record<string, unknown>,
): { inputPath: string; timeoutSec: number } | CallToolResult {
  const resolved = resolveInputPath(args.input as string);
  if ('error' in resolved) return fail(tool, resolved.error, { input: basename(args.input) });
  const timeoutSec = resolveTimeoutSec(args.timeout_seconds);
  if (typeof timeoutSec !== 'number') return fail(tool, timeoutSec.error);
  return { inputPath: resolved.path, timeoutSec };
}

// CRF range gate, shared by `convert.video_crf` and `compress.crf`.
function parseCrf(raw: unknown, field: string): number | { error: string } {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 51) return { error: `${field} must be in [0, 51]` };
  return Math.round(n);
}

/**
 * Best-effort sweep of `ffmpeg-*` files in the tmp dir older than the
 * configured TTL. Run on a timer so that the natural lifecycle is:
 *   tool produces tmp file → agent send_file copies it to outbox → user
 *   receives it → next sweep drops the now-orphan source.
 *
 * The TTL is intentionally several minutes — long enough that a send_file
 * called immediately after a tool return always wins, but short enough that
 * a chain of trim → compress → extract_audio doesn't accumulate disk for
 * an hour. Files newer than the TTL are left alone.
 */
function sweepStaleTmp(ttlMs: number = TMP_TTL_MS): void {
  const dir = tmpDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - ttlMs;
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith('ffmpeg-')) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch {
      // skip
    }
  }
  if (removed > 0) logInfo(`tmp sweep removed ${removed} stale file(s) (ttl ${Math.round(ttlMs / 1000)}s)`);
}

let tmpSweepTimer: ReturnType<typeof setInterval> | null = null;

function startTmpSweepTimer(): void {
  if (tmpSweepTimer) return;
  tmpSweepTimer = setInterval(() => {
    try { sweepStaleTmp(); } catch (e) {
      logErr('tmp-sweep', 'unhandled', { error: e instanceof Error ? e.message : String(e) });
    }
  }, TMP_SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive for cleanup alone.
  if (typeof tmpSweepTimer.unref === 'function') tmpSweepTimer.unref();
}

/** Test-only: stop the periodic sweep so tests don't leak timers. */
export function __stopTmpSweepForTesting(): void {
  if (tmpSweepTimer) {
    clearInterval(tmpSweepTimer);
    tmpSweepTimer = null;
  }
}


const probeTool: Tool = {
  name: 'probe',
  description:
    'Inspect a media file with ffprobe and return its duration, format, and per-stream codec info. Use this before convert/trim to confirm the file is what the agent expects.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the media file (absolute under /workspace, or relative to /workspace/agent).' },
    },
    required: ['path'],
  },
};

async function probeHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const resolved = resolveInputPath(args.path as string);
  if ('error' in resolved) return fail('probe', resolved.error, { path: basename(args.path) });

  const result = await runFfprobe([
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    resolved.path,
  ]);

  if (result.timedOut) return fail('probe', 'ffprobe timed out', { path: path.basename(resolved.path) });
  if (result.exitCode !== 0) {
    return fail('probe', 'ffprobe failed', {
      path: path.basename(resolved.path),
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }

  let parsed: { format?: { duration?: string; size?: string; format_name?: string }; streams?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return fail('probe', 'ffprobe returned invalid JSON', { path: path.basename(resolved.path) });
  }

  const streams = (parsed.streams ?? []).map((s) => ({
    type: s.codec_type as string | undefined,
    codec: s.codec_name as string | undefined,
    width: s.width as number | undefined,
    height: s.height as number | undefined,
    sample_rate: s.sample_rate ? Number(s.sample_rate) : undefined,
    channels: s.channels as number | undefined,
  }));

  return ok({
    duration_s: parsed.format?.duration ? Number(parsed.format.duration) : null,
    size_bytes: parsed.format?.size ? Number(parsed.format.size) : null,
    format: parsed.format?.format_name ?? null,
    streams,
  });
}


const convertTool: Tool = {
  name: 'convert',
  description:
    'Convert a media file to a different format (e.g. mp4 → mp3, mov → mp4, wav → ogg). Returns the path to the new file; chain with mcp__nanoclaw__send_file to deliver.',
  inputSchema: {
    type: 'object',
    properties: {
      input: INPUT_PROP,
      output_format: {
        type: 'string',
        description: `Target format extension (without the dot). Allowed: ${[...OUTPUT_EXT_WHITELIST].sort().join(', ')}.`,
      },
      audio_bitrate_kbps: { type: 'number', description: 'Optional audio bitrate in kbps (e.g. 128, 192, 320).' },
      video_crf: { type: 'number', description: 'Optional H.264/H.265 CRF (lower = higher quality, 18–28 typical).' },
      timeout_seconds: TIMEOUT_PROP,
    },
    required: ['input', 'output_format'],
  },
};

async function convertHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const common = resolveInputAndTimeout('convert', args);
  if ('content' in common) return common;

  const ext = validateOutputExt(String(args.output_format ?? ''));
  if (!ext) return fail('convert', 'Unsupported output_format', { requested: args.output_format });

  const out = makeOutputPath(ext);
  const ffArgs: string[] = ['-i', common.inputPath];

  if (args.audio_bitrate_kbps !== undefined) {
    const br = Number(args.audio_bitrate_kbps);
    if (!Number.isFinite(br) || br <= 0) return fail('convert', 'audio_bitrate_kbps must be a positive number');
    ffArgs.push('-b:a', `${Math.round(br)}k`);
  }
  if (args.video_crf !== undefined) {
    const crf = parseCrf(args.video_crf, 'video_crf');
    if (typeof crf !== 'number') return fail('convert', crf.error);
    ffArgs.push('-crf', String(crf));
  }

  ffArgs.push(out);
  return await runAndPackage('convert', ffArgs, out, ext, { timeoutSec: common.timeoutSec });
}


const trimTool: Tool = {
  name: 'trim',
  description:
    'Cut a [start, start+duration) segment out of a media file. By default keeps the source format; pass output_format to also convert.',
  inputSchema: {
    type: 'object',
    properties: {
      input: INPUT_PROP,
      start_seconds: { type: 'number', description: 'Segment start in seconds (>= 0).' },
      duration_seconds: { type: 'number', description: 'Segment length in seconds (> 0).' },
      output_format: {
        type: 'string',
        description: 'Optional output format extension (defaults to the source extension).',
      },
      timeout_seconds: TIMEOUT_PROP,
    },
    required: ['input', 'start_seconds', 'duration_seconds'],
  },
};

async function trimHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const common = resolveInputAndTimeout('trim', args);
  if ('content' in common) return common;

  const start = Number(args.start_seconds);
  const dur = Number(args.duration_seconds);
  if (!Number.isFinite(start) || start < 0) return fail('trim', 'start_seconds must be >= 0');
  if (!Number.isFinite(dur) || dur <= 0) return fail('trim', 'duration_seconds must be > 0');

  // Probe the source duration so we don't burn CPU on a request whose window
  // sits beyond the end of the file. ffprobe failure is treated as
  // best-effort — fall through and let ffmpeg surface the real error. The
  // probe inherits the per-call timeout so a tight `timeout_seconds` budget
  // bounds both the probe and the encode.
  const total = await probeDurationSec(common.inputPath, common.timeoutSec);
  if (total !== null && total > 0 && start >= total) {
    return fail('trim', `start_seconds (${start}) is past end of media (${total.toFixed(2)}s)`, {
      total_duration_s: total,
    });
  }
  if (total !== null && total > 0 && start + dur > total) {
    return fail('trim', `start_seconds + duration_seconds (${start + dur}) exceeds media duration (${total.toFixed(2)}s)`, {
      total_duration_s: total,
    });
  }

  const sourceExt = path.extname(common.inputPath).slice(1).toLowerCase();
  const requested = args.output_format ? String(args.output_format) : sourceExt;
  const ext = validateOutputExt(requested);
  if (!ext) return fail('trim', 'Unsupported output_format', { requested });

  const out = makeOutputPath(ext);
  // Place -ss before -i for fast seek (keyframe-snapped, accurate enough for most cuts).
  const ffArgs = ['-ss', String(start), '-i', common.inputPath, '-t', String(dur), out];
  return await runAndPackage('trim', ffArgs, out, ext, { timeoutSec: common.timeoutSec });
}


const extractAudioTool: Tool = {
  name: 'extract_audio',
  description:
    'Strip the audio track from a video and save it as a standalone audio file. Defaults to mp3.',
  inputSchema: {
    type: 'object',
    properties: {
      input: INPUT_PROP,
      output_format: {
        type: 'string',
        description: `Audio format extension. Allowed: ${[...AUDIO_ONLY_EXTS].sort().join(', ')}. Default: mp3.`,
      },
      timeout_seconds: TIMEOUT_PROP,
    },
    required: ['input'],
  },
};

async function extractAudioHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const common = resolveInputAndTimeout('extract_audio', args);
  if ('content' in common) return common;

  const requested = String(args.output_format ?? 'mp3').toLowerCase().replace(/^\./, '');
  if (!AUDIO_ONLY_EXTS.has(requested)) {
    return fail('extract_audio', 'Unsupported audio format', { requested });
  }

  const out = makeOutputPath(requested);
  // -vn drops the video stream; let ffmpeg pick the default codec for the container.
  const ffArgs = ['-i', common.inputPath, '-vn', out];
  return await runAndPackage('extract_audio', ffArgs, out, requested, { timeoutSec: common.timeoutSec });
}


const compressTool: Tool = {
  name: 'compress',
  description:
    'Re-encode a media file to reduce size. Pass either `crf` (constant quality, 18–35 typical, lower = bigger) or `target_size_mb` (rough average bitrate for that size). One of the two is required.',
  inputSchema: {
    type: 'object',
    properties: {
      input: INPUT_PROP,
      crf: { type: 'number', description: 'H.264/H.265 CRF in [0, 51]. Mutually exclusive with target_size_mb.' },
      target_size_mb: { type: 'number', description: 'Approx target size in MB. Mutually exclusive with crf.' },
      timeout_seconds: TIMEOUT_PROP,
    },
    required: ['input'],
  },
};

async function compressHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const common = resolveInputAndTimeout('compress', args);
  if ('content' in common) return common;

  const hasCrf = args.crf !== undefined;
  const hasTarget = args.target_size_mb !== undefined;
  if (hasCrf === hasTarget) {
    return fail('compress', 'Pass exactly one of `crf` or `target_size_mb`');
  }

  const sourceExt = path.extname(common.inputPath).slice(1).toLowerCase();
  const ext = validateOutputExt(sourceExt) ?? 'mp4';
  const out = makeOutputPath(ext);
  const ffArgs: string[] = ['-i', common.inputPath];

  if (hasCrf) {
    const crf = parseCrf(args.crf, 'crf');
    if (typeof crf !== 'number') return fail('compress', crf.error);
    ffArgs.push('-crf', String(crf));
  } else {
    const targetMb = Number(args.target_size_mb);
    if (!Number.isFinite(targetMb) || targetMb <= 0) return fail('compress', 'target_size_mb must be > 0');
    // Probe duration to compute bitrate. Failure here is non-fatal — we fall
    // back to a fixed mid-quality CRF. The probe inherits the per-call
    // timeout so a tight budget covers both the probe and the encode.
    const dur = await probeDurationSec(common.inputPath, common.timeoutSec);
    if (dur && dur > 0) {
      const bitrateKbps = Math.max(64, Math.floor((targetMb * 8 * 1024) / dur));
      ffArgs.push('-b:v', `${bitrateKbps}k`);
    } else {
      ffArgs.push('-crf', '28');
    }
  }

  ffArgs.push(out);
  return await runAndPackage('compress', ffArgs, out, ext, { timeoutSec: common.timeoutSec });
}

async function probeDurationSec(filePath: string, timeoutSec: number = DEFAULT_TIMEOUT_SEC): Promise<number | null> {
  const result = await runFfprobe([
    '-print_format', 'json',
    '-show_format',
    filePath,
  ], timeoutSec);
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { format?: { duration?: string } };
    const d = parsed.format?.duration ? Number(parsed.format.duration) : NaN;
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}


async function runAndPackage(
  tool: string,
  ffArgs: string[],
  outPath: string,
  ext: string,
  opts: { timeoutSec?: number } = {},
): Promise<CallToolResult> {
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const result = await runFfmpeg(ffArgs, timeoutSec);

  if (result.timedOut) {
    safeUnlink(outPath);
    return fail(tool, `ffmpeg timed out after ${timeoutSec}s (process killed)`, { timeout_sec: timeoutSec });
  }
  if (result.exitCode !== 0) {
    safeUnlink(outPath);
    return fail(tool, `ffmpeg failed: ${truncStderr(result.stderr)}`, {
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }
  if (!fs.existsSync(outPath)) {
    return fail(tool, 'ffmpeg reported success but no output file was written');
  }

  const stat = fs.statSync(outPath);
  logInfo(`${tool}: wrote ${path.basename(outPath)} (${stat.size} bytes)`);
  return ok({
    path: outPath,
    size_bytes: stat.size,
    mime_type: mimeFor(ext),
  });
}

function safeUnlink(p: string): void {
  try { fs.unlinkSync(p); } catch { /* nothing to clean up */ }
}

function truncStderr(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= 200) return trimmed;
  return trimmed.slice(0, 200) + '...';
}

function basename(input: unknown): string {
  if (typeof input !== 'string') return '<non-string>';
  try { return path.basename(input); } catch { return '<unparseable>'; }
}


const TOOLS: Array<{ tool: Tool; handler: (a: Record<string, unknown>) => Promise<CallToolResult> }> = [
  { tool: probeTool, handler: probeHandler },
  { tool: convertTool, handler: convertHandler },
  { tool: trimTool, handler: trimHandler },
  { tool: extractAudioTool, handler: extractAudioHandler },
  { tool: compressTool, handler: compressHandler },
];

export async function startFfmpegMcpServer(): Promise<void> {
  // Sweep stale intermediates from prior containers/sessions before serving,
  // then keep sweeping on a timer so per-call tmp files don't pile up over
  // the life of this process. Files are only removed once they're older than
  // the TTL, which gives `send_file` time to copy them to the outbox.
  sweepStaleTmp();
  startTmpSweepTimer();

  const server = new Server({ name: 'ffmpeg', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const found = TOOLS.find((t) => t.tool.name === name);
    if (!found) {
      return fail('dispatch', `Unknown tool: ${name}`);
    }
    try {
      return await found.handler(args ?? {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(name, 'Unhandled exception', { error: msg });
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logInfo(`ffmpeg MCP server started with ${TOOLS.length} tools: ${TOOLS.map((t) => t.tool.name).join(', ')}`);
}

// Run when invoked as a script (the only way `bun run server.ts` enters here).
// Skip when imported by tests.
if (import.meta.main) {
  startFfmpegMcpServer().catch((e) => {
    console.error(`[ffmpeg-mcp] fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

// Test-only re-exports. Kept here (rather than `export` at each declaration)
// so the public surface for tests is visible in one place.
export {
  resolveInputPath, validateOutputExt, mimeFor,
  probeHandler, convertHandler, trimHandler, extractAudioHandler, compressHandler,
  resolveTimeoutSec, sweepStaleTmp, tmpDir,
  DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC,
};
