import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_VIDEO_BYTES,
  inboxFilename,
  isSupportedVideoMime,
  materializeAttachment,
  mediaExtForMime,
} from './media.js';

describe('isSupportedVideoMime', () => {
  it('accepts video/mp4', () => {
    expect(isSupportedVideoMime('video/mp4')).toBe(true);
  });
  it('accepts video/quicktime', () => {
    expect(isSupportedVideoMime('video/quicktime')).toBe(true);
  });
  it('rejects video/webm', () => {
    expect(isSupportedVideoMime('video/webm')).toBe(false);
  });
  it('rejects video/avi', () => {
    expect(isSupportedVideoMime('video/avi')).toBe(false);
  });
  it('rejects image/jpeg', () => {
    expect(isSupportedVideoMime('image/jpeg')).toBe(false);
  });
  it('rejects empty string', () => {
    expect(isSupportedVideoMime('')).toBe(false);
  });
  it('rejects undefined-shaped input', () => {
    expect(isSupportedVideoMime(undefined as unknown as string)).toBe(false);
  });
});

describe('mediaExtForMime', () => {
  it('maps image/jpeg to .jpg', () => {
    expect(mediaExtForMime('image/jpeg')).toBe('.jpg');
  });
  it('maps image/png to .jpg because sharp re-encodes', () => {
    expect(mediaExtForMime('image/png')).toBe('.jpg');
  });
  it('maps image/heic to .jpg', () => {
    expect(mediaExtForMime('image/heic')).toBe('.jpg');
  });
  it('maps image/heif to .jpg', () => {
    expect(mediaExtForMime('image/heif')).toBe('.jpg');
  });
  it('maps image/avif to .jpg', () => {
    expect(mediaExtForMime('image/avif')).toBe('.jpg');
  });
  it('maps image/gif to .jpg', () => {
    expect(mediaExtForMime('image/gif')).toBe('.jpg');
  });
  it('maps image/webp to .jpg', () => {
    expect(mediaExtForMime('image/webp')).toBe('.jpg');
  });
  it('maps video/mp4 to .mp4', () => {
    expect(mediaExtForMime('video/mp4')).toBe('.mp4');
  });
  it('maps video/quicktime to .mov', () => {
    expect(mediaExtForMime('video/quicktime')).toBe('.mov');
  });
  it('throws on unknown MIME', () => {
    expect(() => mediaExtForMime('application/pdf')).toThrow();
  });
});

describe('inboxFilename', () => {
  it('builds an ISO-compact-timestamp + file ID + extension', () => {
    const name = inboxFilename({
      timestamp: new Date('2026-05-20T14:30:12.000Z'),
      fileId: 'F012345',
      mime: 'image/jpeg',
    });
    expect(name).toBe('2026-05-20T143012Z-F012345.jpg');
  });

  it('uses .mp4 for video/mp4', () => {
    const name = inboxFilename({
      timestamp: new Date('2026-05-20T14:30:12.000Z'),
      fileId: 'F999XYZ',
      mime: 'video/mp4',
    });
    expect(name).toBe('2026-05-20T143012Z-F999XYZ.mp4');
  });

  it('uses .mov for video/quicktime', () => {
    const name = inboxFilename({
      timestamp: new Date('2026-05-20T14:30:12.000Z'),
      fileId: 'F999XYZ',
      mime: 'video/quicktime',
    });
    expect(name).toBe('2026-05-20T143012Z-F999XYZ.mov');
  });

  it('throws on a file ID containing path-traversal characters', () => {
    expect(() =>
      inboxFilename({
        timestamp: new Date('2026-05-20T14:30:12.000Z'),
        fileId: '../escape',
        mime: 'image/jpeg',
      }),
    ).toThrow();
  });

  it('throws on a lowercase / non-Slack-shaped file ID', () => {
    // Slack file IDs are uppercase alphanumeric (e.g. F0XXXXXXX).
    expect(() =>
      inboxFilename({
        timestamp: new Date('2026-05-20T14:30:12.000Z'),
        fileId: 'f0lowercase',
        mime: 'image/jpeg',
      }),
    ).toThrow();
  });

  it('throws on a file ID with a slash', () => {
    expect(() =>
      inboxFilename({
        timestamp: new Date('2026-05-20T14:30:12.000Z'),
        fileId: 'F012/345',
        mime: 'image/jpeg',
      }),
    ).toThrow();
  });
});

describe('materializeAttachment', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes bytes under inbox/ and returns inbox/<name>', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'mygroup'), { recursive: true });
    const rel = await materializeAttachment({
      bytes: Buffer.from('hello'),
      relName: '2026-05-20T143012Z-F012345.jpg',
      groupFolder: 'mygroup',
      groupsRoot: tmpRoot,
    });
    expect(rel).toBe('inbox/2026-05-20T143012Z-F012345.jpg');

    const written = fs.readFileSync(
      path.join(tmpRoot, 'mygroup', 'inbox', '2026-05-20T143012Z-F012345.jpg'),
    );
    expect(written.toString()).toBe('hello');
  });

  it('creates inbox/ when it does not exist', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'mygroup'), { recursive: true });
    await materializeAttachment({
      bytes: Buffer.from('hi'),
      relName: 'x.jpg',
      groupFolder: 'mygroup',
      groupsRoot: tmpRoot,
    });
    expect(fs.existsSync(path.join(tmpRoot, 'mygroup', 'inbox'))).toBe(true);
  });

  it('throws when groupFolder escapes groupsRoot (../)', async () => {
    await expect(
      materializeAttachment({
        bytes: Buffer.from('x'),
        relName: 'x.jpg',
        groupFolder: '../escaped',
        groupsRoot: tmpRoot,
      }),
    ).rejects.toThrow();
    // No file written outside the root.
    expect(fs.existsSync(path.join(tmpRoot, '..', 'inbox'))).toBe(false);
  });

  it('throws when relName contains path traversal', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'mygroup'), { recursive: true });
    await expect(
      materializeAttachment({
        bytes: Buffer.from('x'),
        relName: '../outside.jpg',
        groupFolder: 'mygroup',
        groupsRoot: tmpRoot,
      }),
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(tmpRoot, 'mygroup', 'outside.jpg'))).toBe(
      false,
    );
  });

  it('throws when relName is absolute', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'mygroup'), { recursive: true });
    await expect(
      materializeAttachment({
        bytes: Buffer.from('x'),
        relName: '/etc/passwd',
        groupFolder: 'mygroup',
        groupsRoot: tmpRoot,
      }),
    ).rejects.toThrow();
  });

  it('overwrites on second call with the same relName', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'mygroup'), { recursive: true });
    await materializeAttachment({
      bytes: Buffer.from('first'),
      relName: 'x.jpg',
      groupFolder: 'mygroup',
      groupsRoot: tmpRoot,
    });
    await materializeAttachment({
      bytes: Buffer.from('second'),
      relName: 'x.jpg',
      groupFolder: 'mygroup',
      groupsRoot: tmpRoot,
    });
    const written = fs.readFileSync(
      path.join(tmpRoot, 'mygroup', 'inbox', 'x.jpg'),
    );
    expect(written.toString()).toBe('second');
  });

  it('writes zero-byte files successfully', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'mygroup'), { recursive: true });
    await materializeAttachment({
      bytes: Buffer.alloc(0),
      relName: 'empty.jpg',
      groupFolder: 'mygroup',
      groupsRoot: tmpRoot,
    });
    const stat = fs.statSync(
      path.join(tmpRoot, 'mygroup', 'inbox', 'empty.jpg'),
    );
    expect(stat.size).toBe(0);
  });
});

describe('MAX_VIDEO_BYTES', () => {
  it('is 100 MB', () => {
    expect(MAX_VIDEO_BYTES).toBe(100 * 1024 * 1024);
  });
});
