/**
 * Tests for image attachment → content block extraction.
 *
 * Uses `setWorkspaceRootForTests` to redirect multimodal.ts's filesystem
 * reads at a temp directory under os.tmpdir(), so the test works without
 * `/workspace` being writable on the host.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

import type { MessageInRow } from './db/messages-in.js';
import { extractImageBlocks, setWorkspaceRootForTests } from './multimodal.js';

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mm-'));
  setWorkspaceRootForTests(workspaceDir);
});

afterEach(() => {
  setWorkspaceRootForTests(null);
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeMsg(content: object, kind: string = 'chat'): MessageInRow {
  return {
    id: 'msg-test',
    seq: 1,
    kind,
    timestamp: new Date().toISOString(),
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: 1,
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify(content),
  } as MessageInRow;
}

function writeWorkspaceFile(relPath: string, bytes: Buffer): void {
  const abs = path.resolve(workspaceDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

describe('extractImageBlocks', () => {
  it('returns [] when messages have no attachments', () => {
    const blocks = extractImageBlocks([makeMsg({ text: 'hello' })]);
    expect(blocks).toEqual([]);
  });

  it('returns [] when messages have non-image attachments only', () => {
    const blocks = extractImageBlocks([
      makeMsg({
        text: 'see attached doc',
        attachments: [{ type: 'document', mimeType: 'application/pdf', localPath: 'inbox/m/doc.pdf', name: 'doc.pdf' }],
      }),
    ]);
    expect(blocks).toEqual([]);
  });

  it('skips images without a localPath', () => {
    const blocks = extractImageBlocks([
      makeMsg({
        text: 'broken image',
        attachments: [{ type: 'image', mimeType: 'image/png', name: 'broken.png' }],
      }),
    ]);
    expect(blocks).toEqual([]);
  });

  it('skips unsupported image mime types', () => {
    const blocks = extractImageBlocks([
      makeMsg({
        text: 'fancy format',
        attachments: [{ type: 'image', mimeType: 'image/heic', localPath: 'inbox/m/x.heic' }],
      }),
    ]);
    expect(blocks).toEqual([]);
  });

  it('refuses unsafe localPaths that escape the workspace root', () => {
    const blocks = extractImageBlocks([
      makeMsg({
        text: 'escape',
        attachments: [{ type: 'image', mimeType: 'image/png', localPath: '../../etc/passwd' }],
      }),
    ]);
    expect(blocks).toEqual([]);
  });

  it('refuses absolute localPaths', () => {
    const blocks = extractImageBlocks([
      makeMsg({
        text: 'abs',
        attachments: [{ type: 'image', mimeType: 'image/png', localPath: '/etc/passwd' }],
      }),
    ]);
    expect(blocks).toEqual([]);
  });

  it('honors skipMultimodal=true even when the image exists', () => {
    writeWorkspaceFile('inbox/skip/img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const blocks = extractImageBlocks([
      makeMsg({
        text: 'opted-out',
        attachments: [
          { type: 'image', mimeType: 'image/png', localPath: 'inbox/skip/img.png', skipMultimodal: true, name: 'img.png' },
        ],
      }),
    ]);
    expect(blocks).toEqual([]);
  });

  it('emits a base64 image block when a supported image is present on disk', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    writeWorkspaceFile('inbox/happy/img.png', bytes);
    const blocks = extractImageBlocks([
      makeMsg({
        text: 'see image',
        attachments: [{ type: 'image', mimeType: 'image/png', localPath: 'inbox/happy/img.png', name: 'img.png' }],
      }),
    ]);
    expect(blocks.length).toBe(1);
    const b = blocks[0];
    expect(b.type).toBe('image');
    if (b.type === 'image') {
      expect(b.source.type).toBe('base64');
      expect(b.source.media_type).toBe('image/png');
      expect(b.source.data).toBe(bytes.toString('base64'));
    }
  });

  it('emits multiple blocks across messages and across attachments per message', () => {
    const b1 = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const b2 = Buffer.from([0xff, 0xd8, 0xff, 0xe1]);
    writeWorkspaceFile('inbox/multi-a/a.jpg', b1);
    writeWorkspaceFile('inbox/multi-b/b.jpg', b2);
    const blocks = extractImageBlocks([
      makeMsg({
        attachments: [
          { type: 'image', mimeType: 'image/jpeg', localPath: 'inbox/multi-a/a.jpg', name: 'a.jpg' },
          { type: 'image', mimeType: 'image/jpeg', localPath: 'inbox/multi-b/b.jpg', name: 'b.jpg' },
        ],
      }),
    ]);
    expect(blocks.length).toBe(2);
  });

  it('ignores task/webhook/system messages — only chat/chat-sdk count', () => {
    writeWorkspaceFile('inbox/task/x.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const blocks = extractImageBlocks([
      makeMsg(
        { attachments: [{ type: 'image', mimeType: 'image/png', localPath: 'inbox/task/x.png' }] },
        'task',
      ),
    ]);
    expect(blocks).toEqual([]);
  });

  it('skips oversize images (over 4MB byte cap)', () => {
    // A 5MB image — over the 4MB cap.
    const big = Buffer.alloc(5 * 1024 * 1024, 0xff);
    writeWorkspaceFile('inbox/big/x.jpg', big);
    const blocks = extractImageBlocks([
      makeMsg({
        attachments: [{ type: 'image', mimeType: 'image/jpeg', localPath: 'inbox/big/x.jpg' }],
      }),
    ]);
    expect(blocks).toEqual([]);
  });

  it('continues past a missing file and emits blocks for the rest', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeWorkspaceFile('inbox/mix/ok.png', bytes);
    const blocks = extractImageBlocks([
      makeMsg({
        attachments: [
          { type: 'image', mimeType: 'image/png', localPath: 'inbox/mix/missing.png' },
          { type: 'image', mimeType: 'image/png', localPath: 'inbox/mix/ok.png' },
        ],
      }),
    ]);
    expect(blocks.length).toBe(1);
  });
});
