import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readSignalAttachments, SIGNAL_MAX_INLINE_ATTACHMENT_BYTES } from './signal.js';

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'signal-att-'));
  mkdirSync(join(dir, 'attachments'));
  return dir;
}

describe('readSignalAttachments', () => {
  it('inlines saved files as base64 data so the host stages them into the inbox', () => {
    const dir = dataDir();
    writeFileSync(join(dir, 'attachments', 'abc.jpg'), Buffer.from('jpegbytes'));
    const refs = readSignalAttachments(dir, [{ id: 'abc.jpg', contentType: 'image/jpeg' }], 'p');
    expect(refs).toEqual([
      {
        type: 'image',
        name: 'abc.jpg',
        mimeType: 'image/jpeg',
        size: 9,
        data: Buffer.from('jpegbytes').toString('base64'),
      },
    ]);
    expect(JSON.stringify(refs)).not.toContain(dir);
  });

  it('adds an extension from the MIME type when the id has none', () => {
    const dir = dataDir();
    writeFileSync(join(dir, 'attachments', 'doc1'), 'x');
    const [ref] = readSignalAttachments(dir, [{ id: 'doc1', contentType: 'application/pdf' }], 'p');
    expect(ref.name).toBe('doc1.pdf');
    expect(ref.type).toBe('application');
  });

  it('marks missing and oversized files instead of passing a host path', () => {
    const dir = dataDir();
    writeFileSync(join(dir, 'attachments', 'big.png'), Buffer.alloc(SIGNAL_MAX_INLINE_ATTACHMENT_BYTES + 1));
    const refs = readSignalAttachments(
      dir,
      [
        { id: 'gone.jpg', contentType: 'image/jpeg' },
        { id: 'big.png', contentType: 'image/png' },
      ],
      'p',
    );
    expect(refs.map((r) => [r.name, r.missing, r.data])).toEqual([
      ['gone.jpg', true, undefined],
      ['big.png', true, undefined],
    ]);
  });

  it('refuses ids that try to leave the attachments dir', () => {
    const dir = dataDir();
    writeFileSync(join(dir, 'secret.jpg'), 's');
    const [ref] = readSignalAttachments(dir, [{ id: '../secret.jpg', contentType: 'image/jpeg' }], 'p');
    expect(ref.missing).toBe(true);
  });
});
