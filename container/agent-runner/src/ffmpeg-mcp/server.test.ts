/**
 * Tests for the ffmpeg MCP server.
 *
 * The spawn layer is swapped out via `__setSpawnForTesting` so we never
 * actually exec ffmpeg/ffprobe — we assert on the argv we would have run
 * and on how the server packages spawn results into MCP responses.
 *
 * The workspace root is overridden to a tmp dir via the
 * NANOCLAW_FFMPEG_WORKSPACE_ROOT env var so tests can stage real fixture
 * files without needing /workspace to exist.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const TEST_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-mcp-test-'));
process.env.NANOCLAW_FFMPEG_WORKSPACE_ROOT = TEST_WORKSPACE;
// Override the tmp output dir to a path under TEST_WORKSPACE so tests stage
// outputs without touching the real /tmp.
process.env.NANOCLAW_FFMPEG_TMP_DIR = path.join(TEST_WORKSPACE, 'agent', 'tmp');

const FIXTURE_DIR = path.join(TEST_WORKSPACE, 'agent', 'test-fixtures');
fs.mkdirSync(FIXTURE_DIR, { recursive: true });

import { afterEach, describe, expect, it } from 'bun:test';

import {
  __setSpawnForTesting,
  resolveInputPath,
  validateOutputExt,
  mimeFor,
  probeHandler,
  convertHandler,
  trimHandler,
  extractAudioHandler,
  compressHandler,
  resolveTimeoutSec,
  sweepStaleTmp,
  tmpDir,
  DEFAULT_TIMEOUT_SEC,
  MAX_TIMEOUT_SEC,
} from './server.js';
import type { RunResult, SpawnFn } from './server.js';

function stageFixture(name: string, contents = 'fake media bytes'): string {
  const p = path.join(FIXTURE_DIR, name);
  fs.writeFileSync(p, contents);
  return p;
}

function makeOutputFile(spawnedArgs: string[], bytes = 'OUT'): void {
  // Handlers expect the output file to exist after a successful spawn.
  // Our argv shape always puts the output path last.
  const out = spawnedArgs[spawnedArgs.length - 1];
  if (out && out.startsWith(path.join(TEST_WORKSPACE, 'agent', 'tmp'))) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, bytes);
  }
}

interface SpawnCall { cmd: string; args: string[] }

function recordingSpawn(result: RunResult): { calls: SpawnCall[]; spawn: SpawnFn } {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'ffmpeg' && result.exitCode === 0) makeOutputFile(args);
    return result;
  };
  return { calls, spawn };
}

const SUCCESS: RunResult = { exitCode: 0, stderr: '', stdout: '', timedOut: false };
const FAIL: RunResult = { exitCode: 1, stderr: 'Invalid data', stdout: '', timedOut: false };
const TIMEOUT: RunResult = { exitCode: 137, stderr: '', stdout: '', timedOut: true };

afterEach(() => {
  __setSpawnForTesting(null);
});

describe('validateOutputExt', () => {
  it('accepts whitelisted extensions case-insensitively', () => {
    expect(validateOutputExt('mp4')).toBe('mp4');
    expect(validateOutputExt('MP3')).toBe('mp3');
    expect(validateOutputExt('.WAV')).toBe('wav');
  });
  it('rejects unknown extensions', () => {
    expect(validateOutputExt('exe')).toBeNull();
    expect(validateOutputExt('sh')).toBeNull();
    expect(validateOutputExt('')).toBeNull();
  });
});

describe('mimeFor', () => {
  it('returns standard MIME types for known extensions', () => {
    expect(mimeFor('mp3')).toBe('audio/mpeg');
    expect(mimeFor('mp4')).toBe('video/mp4');
    expect(mimeFor('webm')).toBe('video/webm');
  });
  it('falls back to octet-stream for unknown', () => {
    expect(mimeFor('xyz')).toBe('application/octet-stream');
  });
});

describe('resolveInputPath', () => {
  it('rejects empty input', () => {
    expect(resolveInputPath('')).toEqual({ error: 'input path is required' });
  });
  it('rejects paths outside the workspace', () => {
    const r = resolveInputPath('/etc/passwd');
    expect('error' in r).toBe(true);
  });
  it('rejects ../ traversal escaping the workspace', () => {
    stageFixture('traversal.txt');
    const r = resolveInputPath(path.join(FIXTURE_DIR, '..', '..', '..', '..', 'etc', 'hostname'));
    expect('error' in r).toBe(true);
  });
  it('accepts valid in-workspace paths', () => {
    const p = stageFixture('clip.mp4');
    const r = resolveInputPath(p);
    expect('path' in r ? r.path : null).toBe(p);
  });
  it('rejects directories', () => {
    const r = resolveInputPath(FIXTURE_DIR);
    expect('error' in r).toBe(true);
  });
});

describe('convert handler', () => {
  it('builds expected ffmpeg argv', async () => {
    const input = stageFixture('a.mp4');
    const { calls, spawn } = recordingSpawn(SUCCESS);
    __setSpawnForTesting(spawn);

    const res = await convertHandler({ input, output_format: 'mp3' });
    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('ffmpeg');
    expect(calls[0].args).toContain('-i');
    expect(calls[0].args).toContain(input);
    const outArg = calls[0].args[calls[0].args.length - 1];
    expect(outArg.endsWith('.mp3')).toBe(true);
  });

  it('rejects disallowed output extensions', async () => {
    const input = stageFixture('b.mp4');
    const { calls, spawn } = recordingSpawn(SUCCESS);
    __setSpawnForTesting(spawn);

    const res = await convertHandler({ input, output_format: 'exe' });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('threads audio_bitrate_kbps as -b:a flag', async () => {
    const input = stageFixture('c.mp4');
    const { calls, spawn } = recordingSpawn(SUCCESS);
    __setSpawnForTesting(spawn);

    await convertHandler({ input, output_format: 'mp3', audio_bitrate_kbps: 192 });
    expect(calls[0].args).toContain('-b:a');
    expect(calls[0].args).toContain('192k');
  });

  it('rejects negative bitrate', async () => {
    const input = stageFixture('d.mp4');
    const { calls, spawn } = recordingSpawn(SUCCESS);
    __setSpawnForTesting(spawn);

    const res = await convertHandler({ input, output_format: 'mp3', audio_bitrate_kbps: -1 });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('surfaces ffmpeg failure with stderr', async () => {
    const input = stageFixture('e.mp4');
    const { spawn } = recordingSpawn(FAIL);
    __setSpawnForTesting(spawn);

    const res = await convertHandler({ input, output_format: 'mp3' });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('ffmpeg failed');
    expect(text).toContain('Invalid data');
  });

  it('reports timeouts distinctly', async () => {
    const input = stageFixture('f.mp4');
    const { spawn } = recordingSpawn(TIMEOUT);
    __setSpawnForTesting(spawn);

    const res = await convertHandler({ input, output_format: 'mp3' });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('timed out');
  });
});

describe('trim handler', () => {
  it('threads start and duration as ffmpeg flags', async () => {
    const input = stageFixture('t.mp4');
    const { calls, spawn } = recordingSpawn(SUCCESS);
    __setSpawnForTesting(spawn);

    await trimHandler({ input, start_seconds: 5, duration_seconds: 10 });
    // trim probes the source first; assert against the ffmpeg call.
    const ffmpegCall = calls.find((c) => c.cmd === 'ffmpeg');
    expect(ffmpegCall).toBeDefined();
    expect(ffmpegCall!.args).toContain('-ss');
    expect(ffmpegCall!.args).toContain('5');
    expect(ffmpegCall!.args).toContain('-t');
    expect(ffmpegCall!.args).toContain('10');
  });

  it('rejects negative start', async () => {
    const input = stageFixture('t2.mp4');
    const { calls, spawn } = recordingSpawn(SUCCESS);
    __setSpawnForTesting(spawn);

    const res = await trimHandler({ input, start_seconds: -1, duration_seconds: 5 });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rejects zero duration', async () => {
    const input = stageFixture('t3.mp4');
    const { calls, spawn } = recordingSpawn(SUCCESS);
    __setSpawnForTesting(spawn);

    const res = await trimHandler({ input, start_seconds: 0, duration_seconds: 0 });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('defaults output_format to source extension', async () => {
    const input = stageFixture('keep.webm');
    const { calls, spawn } = recordingSpawn(SUCCESS);
    __setSpawnForTesting(spawn);

    await trimHandler({ input, start_seconds: 0, duration_seconds: 1 });
    const ffmpegCall = calls.find((c) => c.cmd === 'ffmpeg');
    expect(ffmpegCall).toBeDefined();
    const out = ffmpegCall!.args[ffmpegCall!.args.length - 1];
    expect(out.endsWith('.webm')).toBe(true);
  });
});

describe('extract_audio handler', () => {
  it('passes -vn to drop video', async () => {
    const input = stageFixture('movie.mp4');
    const { calls, spawn } = recordingSpawn(SUCCESS);
    __setSpawnForTesting(spawn);

    await extractAudioHandler({ input });
    expect(calls[0].args).toContain('-vn');
    const out = calls[0].args[calls[0].args.length - 1];
    expect(out.endsWith('.mp3')).toBe(true);
  });

  it('rejects video output formats', async () => {
    const input = stageFixture('movie2.mp4');
    const { calls, spawn } = recordingSpawn(SUCCESS);
    __setSpawnForTesting(spawn);

    const res = await extractAudioHandler({ input, output_format: 'mp4' });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('compress handler', () => {
  it('requires exactly one of crf or target_size_mb', async () => {
    const input = stageFixture('big.mp4');
    const { calls, spawn } = recordingSpawn(SUCCESS);
    __setSpawnForTesting(spawn);

    const neither = await compressHandler({ input });
    expect(neither.isError).toBe(true);

    const both = await compressHandler({ input, crf: 28, target_size_mb: 5 });
    expect(both.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('threads crf flag when provided', async () => {
    const input = stageFixture('big2.mp4');
    const { calls, spawn } = recordingSpawn(SUCCESS);
    __setSpawnForTesting(spawn);

    await compressHandler({ input, crf: 24 });
    expect(calls[0].args).toContain('-crf');
    expect(calls[0].args).toContain('24');
  });

  it('rejects out-of-range crf', async () => {
    const input = stageFixture('big3.mp4');
    const { calls, spawn } = recordingSpawn(SUCCESS);
    __setSpawnForTesting(spawn);

    const res = await compressHandler({ input, crf: 99 });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('resolveTimeoutSec', () => {
  it('returns the default when arg is omitted', () => {
    expect(resolveTimeoutSec(undefined)).toBe(DEFAULT_TIMEOUT_SEC);
    expect(resolveTimeoutSec(null)).toBe(DEFAULT_TIMEOUT_SEC);
  });
  it('accepts in-range numbers', () => {
    expect(resolveTimeoutSec(60)).toBe(60);
    expect(resolveTimeoutSec('120')).toBe(120);
  });
  it('rejects non-positive and non-numeric', () => {
    expect(typeof resolveTimeoutSec(0)).toBe('object');
    expect(typeof resolveTimeoutSec(-1)).toBe('object');
    expect(typeof resolveTimeoutSec('not-a-number')).toBe('object');
  });
  it('rejects below the floor', () => {
    expect(typeof resolveTimeoutSec(1)).toBe('object');
  });
  it('rejects above the ceiling', () => {
    expect(typeof resolveTimeoutSec(MAX_TIMEOUT_SEC + 1)).toBe('object');
  });
  it('per-call ceiling never falls below the operator-configured default', () => {
    // If an operator deliberately sets NANOCLAW_FFMPEG_TIMEOUT_SEC above the
    // baseline 1800s ceiling, an agent must still be able to opt into that
    // larger budget — otherwise the policy is asymmetric (the default is
    // allowed but no explicit request matching it is). Asserts the invariant
    // even though this test process didn't set the env override itself.
    expect(MAX_TIMEOUT_SEC).toBeGreaterThanOrEqual(DEFAULT_TIMEOUT_SEC);
  });
});

describe('trim duration validation', () => {
  // Spawn that answers ffprobe with real metadata and ffmpeg with success,
  // so we can assert on whether ffmpeg ran or was short-circuited.
  function dualSpawn(durationSec: number): { calls: SpawnCall[]; spawn: SpawnFn } {
    const calls: SpawnCall[] = [];
    const spawn: SpawnFn = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'ffprobe') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ format: { duration: String(durationSec) } }),
          stderr: '',
          timedOut: false,
        };
      }
      makeOutputFile(args);
      return SUCCESS;
    };
    return { calls, spawn };
  }

  it('rejects when start_seconds is past the end of the file', async () => {
    const input = stageFixture('clip-short.mp4');
    const { calls, spawn } = dualSpawn(10);
    __setSpawnForTesting(spawn);

    const res = await trimHandler({ input, start_seconds: 30, duration_seconds: 1 });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('past end of media');
    // ffprobe ran, ffmpeg did not.
    expect(calls.some((c) => c.cmd === 'ffmpeg')).toBe(false);
  });

  it('rejects when start + duration overruns the file', async () => {
    const input = stageFixture('clip-mid.mp4');
    const { calls, spawn } = dualSpawn(10);
    __setSpawnForTesting(spawn);

    const res = await trimHandler({ input, start_seconds: 5, duration_seconds: 10 });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('exceeds media duration');
    expect(calls.some((c) => c.cmd === 'ffmpeg')).toBe(false);
  });

  it('proceeds when the window fits inside the file', async () => {
    const input = stageFixture('clip-ok.mp4');
    const { calls, spawn } = dualSpawn(60);
    __setSpawnForTesting(spawn);

    const res = await trimHandler({ input, start_seconds: 5, duration_seconds: 10 });
    expect(res.isError).toBeFalsy();
    expect(calls.some((c) => c.cmd === 'ffmpeg')).toBe(true);
  });

  it('proceeds when ffprobe cannot determine duration', async () => {
    const input = stageFixture('clip-unknown.mp4');
    const calls: SpawnCall[] = [];
    const spawn: SpawnFn = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'ffprobe') {
        return { exitCode: 1, stdout: '', stderr: 'oops', timedOut: false };
      }
      makeOutputFile(args);
      return SUCCESS;
    };
    __setSpawnForTesting(spawn);

    const res = await trimHandler({ input, start_seconds: 0, duration_seconds: 5 });
    expect(res.isError).toBeFalsy();
    expect(calls.some((c) => c.cmd === 'ffmpeg')).toBe(true);
  });
});

describe('per-call timeout_seconds', () => {
  it('threads a custom timeout through to the spawn layer', async () => {
    const input = stageFixture('clip-timeout.mp4');
    const captured: number[] = [];
    const spawn: SpawnFn = async (cmd, args, timeoutSec) => {
      captured.push(timeoutSec);
      if (cmd === 'ffmpeg') makeOutputFile(args);
      return SUCCESS;
    };
    __setSpawnForTesting(spawn);

    await convertHandler({ input, output_format: 'mp3', timeout_seconds: 42 });
    // ffmpeg call uses the custom timeout. ffprobe (if any) is not relevant
    // here because convert doesn't probe.
    expect(captured).toContain(42);
  });

  it('rejects out-of-range timeouts before spawning', async () => {
    const input = stageFixture('clip-timeout2.mp4');
    const { calls, spawn } = recordingSpawn(SUCCESS);
    __setSpawnForTesting(spawn);

    const res = await convertHandler({ input, output_format: 'mp3', timeout_seconds: 99999 });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("trim's probe inherits the per-call timeout instead of the global default", async () => {
    const input = stageFixture('clip-probe-timeout.mp4');
    const captured: { cmd: string; timeoutSec: number }[] = [];
    const spawn: SpawnFn = async (cmd, args, timeoutSec) => {
      captured.push({ cmd, timeoutSec });
      if (cmd === 'ffprobe') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ format: { duration: '60' } }),
          stderr: '',
          timedOut: false,
        };
      }
      makeOutputFile(args);
      return SUCCESS;
    };
    __setSpawnForTesting(spawn);

    await trimHandler({ input, start_seconds: 0, duration_seconds: 5, timeout_seconds: 30 });
    const probeCall = captured.find((c) => c.cmd === 'ffprobe');
    const ffmpegCall = captured.find((c) => c.cmd === 'ffmpeg');
    expect(probeCall?.timeoutSec).toBe(30);
    expect(ffmpegCall?.timeoutSec).toBe(30);
  });

  it('reports the custom timeout in the error message on expiry', async () => {
    const input = stageFixture('clip-timeout3.mp4');
    const { spawn } = recordingSpawn(TIMEOUT);
    __setSpawnForTesting(spawn);

    const res = await convertHandler({ input, output_format: 'mp3', timeout_seconds: 17 });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('17s');
    expect(text).toContain('killed');
  });
});

describe('tmp file cleanup', () => {
  it('sweepStaleTmp deletes files older than the TTL and keeps recent ones', () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });

    const stale = path.join(dir, `ffmpeg-stale-${Date.now()}.mp4`);
    const fresh = path.join(dir, `ffmpeg-fresh-${Date.now()}.mp4`);
    fs.writeFileSync(stale, 'old');
    fs.writeFileSync(fresh, 'new');
    // Backdate `stale` to two hours ago.
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);

    sweepStaleTmp(60 * 60 * 1000); // 1h TTL

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    fs.unlinkSync(fresh);
  });

  it('sweepStaleTmp ignores tmp files without the ffmpeg- prefix', () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    const other = path.join(dir, 'random-output.mp4');
    fs.writeFileSync(other, 'bytes');
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(other, twoHoursAgo, twoHoursAgo);

    sweepStaleTmp(60 * 60 * 1000);

    expect(fs.existsSync(other)).toBe(true);
    fs.unlinkSync(other);
  });

  it('does not delete the input file on a successful tool call', async () => {
    // Tools used to consume their input on success when the input was a
    // prior tmp file. That was destructive (it broke fan-out reuse of an
    // intermediate). Lifecycle is now owned by the periodic sweep alone.
    const input = stageFixture('reusable-source.mp4', 'bytes');
    const { spawn } = recordingSpawn(SUCCESS);
    __setSpawnForTesting(spawn);

    const r = await convertHandler({ input, output_format: 'mp3' });
    expect(r.isError).toBeFalsy();
    expect(fs.existsSync(input)).toBe(true);
  });
});

describe('probe handler', () => {
  it('parses ffprobe JSON into a structured response', async () => {
    const input = stageFixture('p.mp4');
    const probeJson = JSON.stringify({
      format: { duration: '12.34', size: '4096', format_name: 'mov,mp4,m4a' },
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
        { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
      ],
    });
    const { spawn } = recordingSpawn({ exitCode: 0, stderr: '', stdout: probeJson, timedOut: false });
    __setSpawnForTesting(spawn);

    const res = await probeHandler({ path: input });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.ok).toBe(true);
    expect(parsed.duration_s).toBe(12.34);
    expect(parsed.streams).toHaveLength(2);
    expect(parsed.streams[0].codec).toBe('h264');
  });

  it('reports invalid JSON cleanly', async () => {
    const input = stageFixture('p2.mp4');
    const { spawn } = recordingSpawn({ exitCode: 0, stderr: '', stdout: 'not json', timedOut: false });
    __setSpawnForTesting(spawn);

    const res = await probeHandler({ path: input });
    expect(res.isError).toBe(true);
  });
});
