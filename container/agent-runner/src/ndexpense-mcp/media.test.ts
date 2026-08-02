import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveReceiptMedia } from './media.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ndexpense-media-'));
  roots.push(path);
  return path;
}

describe('resolveReceiptMedia', () => {
  test('accepts matching JPEG magic bytes inside the downloads root', async () => {
    const downloads = await root();
    const file = join(downloads, 'receipt.jpg');
    await writeFile(file, Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0, 1]));

    const [resolved] = await resolveReceiptMedia([file], downloads);

    expect(resolved.type).toBe('image/jpeg');
    expect(resolved.size).toBe(6);
  });

  test('rejects traversal, symlinks, and mismatched magic bytes', async () => {
    const downloads = await root();
    const outside = join(await root(), 'outside.pdf');
    await writeFile(outside, '%PDF-1.7');
    const link = join(downloads, 'link.pdf');
    await symlink(outside, link);
    const fake = join(downloads, 'fake.png');
    await writeFile(fake, 'not a png');

    await expect(resolveReceiptMedia([outside], downloads)).rejects.toThrow('downloads');
    await expect(resolveReceiptMedia([link], downloads)).rejects.toThrow('symlink');
    await expect(resolveReceiptMedia([fake], downloads)).rejects.toThrow('content');
  });

  test('enforces file count and aggregate size limits', async () => {
    const downloads = await root();
    const paths: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const file = join(downloads, `${index}.pdf`);
      await writeFile(file, '%PDF-1.7');
      paths.push(file);
    }

    await expect(resolveReceiptMedia(paths, downloads)).rejects.toThrow('10 files');
  });
});
