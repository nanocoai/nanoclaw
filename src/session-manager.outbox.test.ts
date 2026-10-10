/**
 * The session folder is mounted read-write into the container, so every name
 * below it — including `outbox` itself — belongs to the container. Reading and
 * clearing a message's outbox must stay inside the session folder no matter
 * what the container turns those names into.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-outbox-root' };
});

import { clearOutbox, readOutboxFiles, sessionDir } from './session-manager.js';

const TEST_DIR = '/tmp/nanoclaw-test-outbox-root';
const AG = 'ag-outbox';
const SESS = 'sess-outbox';

/** A host directory outside the session folder, shaped like `outbox/<msg>/secret.txt`. */
function hostDirWithMessage(messageId: string): string {
  const hostDir = path.join(TEST_DIR, 'host-outside');
  fs.mkdirSync(path.join(hostDir, messageId), { recursive: true });
  fs.writeFileSync(path.join(hostDir, messageId, 'secret.txt'), 'host-secret');
  return hostDir;
}

function outboxRoot(): string {
  return path.join(sessionDir(AG, SESS), 'outbox');
}

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(outboxRoot(), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('outbox root replaced by a symlink', () => {
  beforeEach(() => {
    const hostDir = hostDirWithMessage('msg-1');
    fs.rmSync(outboxRoot(), { recursive: true });
    fs.symlinkSync(hostDir, outboxRoot());
  });

  it('readOutboxFiles reads nothing through it', () => {
    expect(readOutboxFiles(AG, SESS, 'msg-1', ['secret.txt'])).toBeUndefined();
  });

  it('clearOutbox deletes nothing through it', () => {
    clearOutbox(AG, SESS, 'msg-1');

    expect(fs.readFileSync(path.join(TEST_DIR, 'host-outside', 'msg-1', 'secret.txt'), 'utf-8')).toBe('host-secret');
  });
});

describe('outbox root swapped while clearing', () => {
  it('clearOutbox only removes entries of the directory it opened', () => {
    const hostDir = hostDirWithMessage('msg-2');
    fs.mkdirSync(path.join(outboxRoot(), 'msg-2'));
    fs.writeFileSync(path.join(outboxRoot(), 'msg-2', 'secret.txt'), 'agent-file');

    // Swap right before the first destructive call, after every check.
    let swapped = false;
    for (const method of ['rmSync', 'unlinkSync', 'rmdirSync'] as const) {
      const original = fs[method] as (...args: unknown[]) => unknown;
      vi.spyOn(fs, method).mockImplementation(((...args: unknown[]) => {
        if (!swapped) {
          swapped = true;
          fs.renameSync(outboxRoot(), `${outboxRoot()}-moved`);
          fs.symlinkSync(hostDir, outboxRoot());
        }
        return original.apply(fs, args);
      }) as never);
    }

    clearOutbox(AG, SESS, 'msg-2');

    expect(swapped).toBe(true);
    expect(fs.readFileSync(path.join(hostDir, 'msg-2', 'secret.txt'), 'utf-8')).toBe('host-secret');
  });
});

describe('outbox happy path', () => {
  it('reads the declared files and clears the message dir', () => {
    fs.mkdirSync(path.join(outboxRoot(), 'msg-ok'));
    fs.writeFileSync(path.join(outboxRoot(), 'msg-ok', 'report.txt'), 'report');

    const files = readOutboxFiles(AG, SESS, 'msg-ok', ['report.txt', 'missing.txt']);
    expect(files?.map((f) => [f.filename, f.data.toString()])).toEqual([['report.txt', 'report']]);

    clearOutbox(AG, SESS, 'msg-ok');
    expect(fs.existsSync(path.join(outboxRoot(), 'msg-ok'))).toBe(false);
    expect(fs.existsSync(outboxRoot())).toBe(true);
  });

  it('removes a planted symlink entry without touching its target', () => {
    const target = path.join(TEST_DIR, 'link-target.txt');
    fs.writeFileSync(target, 'keep');
    fs.mkdirSync(path.join(outboxRoot(), 'msg-link'));
    fs.symlinkSync(target, path.join(outboxRoot(), 'msg-link', 'doc.txt'));

    expect(readOutboxFiles(AG, SESS, 'msg-link', ['doc.txt'])).toBeUndefined();
    clearOutbox(AG, SESS, 'msg-link');

    expect(fs.existsSync(path.join(outboxRoot(), 'msg-link'))).toBe(false);
    expect(fs.readFileSync(target, 'utf-8')).toBe('keep');
  });
});
