import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import type { ChildProcess } from 'child_process';

import { PdfExtractionError, extractPdfText, isPdfMime } from './pdf-extract.js';

/**
 * Build a fake ChildProcess-like object that:
 * - exposes stdout / stderr Readable streams that emit the given chunks
 * - exposes stdin as a Writable that collects pushed bytes (no-op sink)
 * - emits 'close' with the given exit code shortly after the test calls end()
 * - emits 'error' if `errorCode` is provided (e.g. 'ENOENT')
 */
function fakeChild(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  errorCode?: NodeJS.ErrnoException['code'];
  emitOnSpawn?: boolean;
}): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: Writable;
    kill: (signal?: string) => boolean;
  };

  child.stdout = new Readable({
    read() {
      /* push happens in setImmediate below */
    },
  });
  child.stderr = new Readable({
    read() {
      /* push happens in setImmediate below */
    },
  });
  child.stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
    final(cb) {
      cb();
    },
  });
  child.kill = () => true;

  setImmediate(() => {
    if (opts.errorCode) {
      const err: NodeJS.ErrnoException = new Error('spawn failed');
      err.code = opts.errorCode;
      child.emit('error', err);
      return;
    }
    if (opts.stdout) child.stdout.push(opts.stdout);
    child.stdout.push(null);
    if (opts.stderr) child.stderr.push(opts.stderr);
    child.stderr.push(null);
    setImmediate(() => child.emit('close', opts.exitCode ?? 0));
  });

  return child as unknown as ChildProcess;
}

describe('isPdfMime', () => {
  it('accepts application/pdf and application/x-pdf', () => {
    expect(isPdfMime('application/pdf')).toBe(true);
    expect(isPdfMime('Application/PDF')).toBe(true);
    expect(isPdfMime('application/x-pdf')).toBe(true);
  });

  it('rejects unrelated mime types', () => {
    expect(isPdfMime(undefined)).toBe(false);
    expect(isPdfMime('image/png')).toBe(false);
    expect(isPdfMime('audio/ogg')).toBe(false);
    expect(isPdfMime('text/plain')).toBe(false);
  });
});

describe('extractPdfText', () => {
  it('throws too-large for empty buffer', async () => {
    await expect(
      extractPdfText(Buffer.alloc(0), {
        spawnImpl: (() => fakeChild({ stdout: 'never' })) as unknown as typeof import('child_process').spawn,
      }),
    ).rejects.toMatchObject({ kind: 'too-large' });
  });

  it('throws too-large when input exceeds 50MB cap', async () => {
    const big = Buffer.alloc(51 * 1024 * 1024, 0x00);
    await expect(
      extractPdfText(big, {
        spawnImpl: (() => fakeChild({ stdout: 'never' })) as unknown as typeof import('child_process').spawn,
      }),
    ).rejects.toMatchObject({ kind: 'too-large' });
  });

  it('returns trimmed text on a normal exit', async () => {
    const out = await extractPdfText(Buffer.from('%PDF-1.4 etc'), {
      spawnImpl: (() => fakeChild({ stdout: '  Hello world  \n' })) as unknown as typeof import('child_process').spawn,
    });
    expect(out).toBe('Hello world');
  });

  it('throws binary-missing when spawn emits ENOENT', async () => {
    await expect(
      extractPdfText(Buffer.from('%PDF-1.4 etc'), {
        spawnImpl: (() => fakeChild({ errorCode: 'ENOENT' })) as unknown as typeof import('child_process').spawn,
      }),
    ).rejects.toMatchObject({ kind: 'binary-missing' });
  });

  it('throws spawn-failed when spawn synchronously throws', async () => {
    const throwing = (() => {
      throw new Error('boom');
    }) as unknown as typeof import('child_process').spawn;
    await expect(extractPdfText(Buffer.from('%PDF-1.4 etc'), { spawnImpl: throwing })).rejects.toMatchObject({
      kind: 'spawn-failed',
    });
  });

  it('throws nonzero-exit when pdftotext returns a non-zero status', async () => {
    await expect(
      extractPdfText(Buffer.from('not a pdf'), {
        spawnImpl: (() =>
          fakeChild({
            exitCode: 2,
            stderr: 'Syntax Error: Document missing',
          })) as unknown as typeof import('child_process').spawn,
      }),
    ).rejects.toMatchObject({ kind: 'nonzero-exit' });
  });

  it('throws empty-output when pdftotext succeeds with no text', async () => {
    await expect(
      extractPdfText(Buffer.from('%PDF-1.4 etc'), {
        spawnImpl: (() => fakeChild({ stdout: '   ' })) as unknown as typeof import('child_process').spawn,
      }),
    ).rejects.toMatchObject({ kind: 'empty-output' });
  });

  it('TruncatesText output past the byte cap', async () => {
    // 300KB of "X" — over the 250_000 byte extracted-text cap. Should
    // truncate silently without throwing.
    const huge = 'X'.repeat(300_000);
    const out = await extractPdfText(Buffer.from('%PDF-1.4 etc'), {
      spawnImpl: (() => fakeChild({ stdout: huge })) as unknown as typeof import('child_process').spawn,
    });
    expect(out.length).toBeLessThanOrEqual(250_000);
    expect(out.length).toBeGreaterThan(100_000);
  });

  it('export: PdfExtractionError carries a kind', () => {
    const e = new PdfExtractionError('binary-missing', 'pdftotext not installed');
    expect(e.kind).toBe('binary-missing');
    expect(e.message).toContain('pdftotext');
  });
});
