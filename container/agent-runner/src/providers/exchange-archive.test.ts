import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { archiveProviderExchange } from './exchange-archive.js';

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function makeTmpDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-archive-'));
  return tmpDir;
}

describe('provider exchange archive', () => {
  it('appends same-thread exchanges into one file with a single header', () => {
    const conversationsDir = makeTmpDir();
    const timestamp = new Date('2026-06-03T12:34:56.789Z');

    const first = archiveProviderExchange({
      conversationsDir,
      provider: 'codex',
      prompt: 'hello',
      result: 'world',
      continuation: 'thread-123',
      status: 'completed',
      timestamp,
    });
    const second = archiveProviderExchange({
      conversationsDir,
      provider: 'codex',
      prompt: 'hello again',
      result: 'world again',
      continuation: 'thread-123',
      status: 'completed',
      timestamp,
    });

    // Same thread → same date-prefixed, thread-stable file, not one per exchange.
    expect(first).toBe('2026-06-03-codex-thread-123.md');
    expect(second).toBe(first);
    expect(fs.readdirSync(conversationsDir)).toHaveLength(1);

    const content = fs.readFileSync(path.join(conversationsDir, first!), 'utf-8');
    // Header (thread-level metadata) written exactly once.
    expect(content.match(/# Codex Conversation/g)).toHaveLength(1);
    expect(content).toContain('Provider: codex');
    expect(content).toContain('Continuation/thread id: thread-123');
    // Both exchanges present, each with its own status line.
    expect(content).toContain('**User**: hello');
    expect(content).toContain('**Assistant**: world');
    expect(content).toContain('**User**: hello again');
    expect(content).toContain('**Assistant**: world again');
    expect(content.match(/Status: completed/g)).toHaveLength(2);
  });

  it('writes a separate file per thread', () => {
    const conversationsDir = makeTmpDir();
    const timestamp = new Date('2026-06-03T12:34:56.789Z');

    const a = archiveProviderExchange({
      conversationsDir,
      provider: 'codex',
      prompt: 'p',
      result: 'r',
      continuation: 'thread-a',
      status: 'completed',
      timestamp,
    });
    const b = archiveProviderExchange({
      conversationsDir,
      provider: 'codex',
      prompt: 'p',
      result: 'r',
      continuation: 'thread-b',
      status: 'completed',
      timestamp,
    });

    expect(a).toBe('2026-06-03-codex-thread-a.md');
    expect(b).toBe('2026-06-03-codex-thread-b.md');
    expect(fs.readdirSync(conversationsDir)).toHaveLength(2);
  });

  it('keeps the creation-date prefix stable when later exchanges land on another day', () => {
    const conversationsDir = makeTmpDir();

    const first = archiveProviderExchange({
      conversationsDir,
      provider: 'codex',
      prompt: 'a',
      result: 'b',
      continuation: 'thread-x',
      status: 'completed',
      timestamp: new Date('2026-06-03T10:00:00.000Z'),
    });
    // A later exchange on a different day must append to the same file, not
    // mint a new 2026-06-05-* one (the bug a naive date-from-timestamp scheme
    // would introduce).
    const second = archiveProviderExchange({
      conversationsDir,
      provider: 'codex',
      prompt: 'c',
      result: 'd',
      continuation: 'thread-x',
      status: 'completed',
      timestamp: new Date('2026-06-05T10:00:00.000Z'),
    });

    expect(first).toBe('2026-06-03-codex-thread-x.md');
    expect(second).toBe(first);
    expect(fs.readdirSync(conversationsDir)).toHaveLength(1);
  });

  it('skips empty result text', () => {
    const conversationsDir = makeTmpDir();
    const filename = archiveProviderExchange({
      conversationsDir,
      provider: 'codex',
      prompt: 'hello',
      result: '   ',
      continuation: 'thread-123',
      status: 'completed',
    });

    expect(filename).toBeNull();
    expect(fs.readdirSync(conversationsDir)).toHaveLength(0);
  });
});
