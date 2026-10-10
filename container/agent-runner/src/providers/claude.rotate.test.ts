import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import './index.js';
import '../provider-contracts/index.js';
import { createProvider } from './factory.js';

// maybeRotateContinuation guards the cold-resume failure mode: a long-lived
// session whose on-disk transcript has grown so large (or old) that the SDK
// can't reload it before the host's idle ceiling kills the container.

let tmp: string;
let prevHome: string | undefined;
let prevConv: string | undefined;
let prevBytes: string | undefined;
let prevDays: string | undefined;

const PROJECT_DIR = '-workspace-agent';
const CWD = '/workspace/agent';

function writeTranscript(sessionId: string, bytes: number, firstTs?: string): string {
  const dir = path.join(tmp, '.claude', 'projects', PROJECT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${sessionId}.jsonl`);
  const first =
    JSON.stringify({
      type: 'user',
      timestamp: firstTs ?? new Date().toISOString(),
      message: { role: 'user', content: 'hello' },
    }) + '\n';
  const filler = 'x'.repeat(Math.max(0, bytes - first.length));
  fs.writeFileSync(p, first + filler);
  return p;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-rotate-'));
  prevHome = process.env.HOME;
  prevConv = process.env.NANOCLAW_CONVERSATIONS_DIR;
  prevBytes = process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES;
  prevDays = process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS;
  process.env.HOME = tmp;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.NANOCLAW_CONVERSATIONS_DIR = path.join(tmp, 'conversations');
});

afterEach(() => {
  const restore = (k: string, v: string | undefined) =>
    v === undefined ? delete process.env[k] : (process.env[k] = v);
  restore('HOME', prevHome);
  restore('NANOCLAW_CONVERSATIONS_DIR', prevConv);
  restore('CLAUDE_TRANSCRIPT_ROTATE_BYTES', prevBytes);
  restore('CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS', prevDays);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('claude maybeRotateContinuation', () => {
  it('keeps a small, recent transcript (returns null, leaves file in place)', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(1024 * 1024);
    const p = writeTranscript('sess-small', 4096);
    const provider = createProvider('claude');
    expect(provider.maybeRotateContinuation!('sess-small', CWD)).toBeNull();
    expect(fs.existsSync(p)).toBe(true);
  });

  it('rotates an oversized transcript (returns reason, moves the .jsonl aside)', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(64 * 1024);
    const p = writeTranscript('sess-big', 200 * 1024);
    const provider = createProvider('claude');
    const reason = provider.maybeRotateContinuation!('sess-big', CWD);
    expect(reason).toContain('MB');
    expect(fs.existsSync(p)).toBe(false); // original moved out of the resume path
    const dir = path.dirname(p);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('sess-big.jsonl.rotated-'))).toBe(true);
  });

  it('rotates by size when the first line and archive read both fail', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(64 * 1024);
    const p = writeTranscript('sess-unreadable', 200 * 1024);
    let firstLineReadAttempted = false;
    let archiveReadAttempted = false;
    let archiveFailureLogged = false;
    const openSpy = spyOn(fs, 'openSync').mockImplementation(() => {
      firstLineReadAttempted = true;
      throw new Error('first line unreadable');
    });
    const readSpy = spyOn(fs, 'readFileSync').mockImplementation(() => {
      archiveReadAttempted = true;
      throw new Error('archive unreadable');
    });
    const errorSpy = spyOn(console, 'error').mockImplementation((line) => {
      if (String(line).includes('Failed to archive transcript')) archiveFailureLogged = true;
    });
    const renameClock = 1_234_567_890;
    let clockReads = 0;
    const nowSpy = spyOn(Date, 'now').mockImplementation(() => {
      clockReads++;
      return renameClock;
    });
    let reason: string | null;
    try {
      reason = createProvider('claude').maybeRotateContinuation!('sess-unreadable', CWD);
    } finally {
      openSpy.mockRestore();
      readSpy.mockRestore();
      errorSpy.mockRestore();
      nowSpy.mockRestore();
    }

    expect(reason!).toContain('MB');
    expect(firstLineReadAttempted).toBe(true);
    expect(archiveReadAttempted).toBe(true);
    expect(archiveFailureLogged).toBe(true);
    expect(clockReads).toBe(1);
    expect(fs.existsSync(p)).toBe(false);
    expect(fs.readdirSync(path.dirname(p))).toContain(`sess-unreadable.jsonl.rotated-${renameClock}`);
  });

  it('rotates an aged transcript even when small', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(1024 * 1024);
    process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS = '7';
    const old = new Date(Date.now() - 10 * 86400_000).toISOString();
    writeTranscript('sess-old', 2048, old);
    const provider = createProvider('claude');
    expect(provider.maybeRotateContinuation!('sess-old', CWD)).toContain('d');
  });

  it('returns null for an unknown session id', () => {
    const provider = createProvider('claude');
    expect(provider.maybeRotateContinuation!('does-not-exist', CWD)).toBeNull();
  });
});
