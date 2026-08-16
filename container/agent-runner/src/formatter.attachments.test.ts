/**
 * Tests for `extractAttachments` — the structured view of a batch's channel
 * attachments.
 *
 * The prompt text produced by `formatMessages` already describes every
 * attachment inline, and that stays the contract for every provider. This
 * extraction is the additive seam so a provider whose SDK takes real file
 * parts can hand the actual bytes to a multimodal model instead of a sentence
 * claiming a photo exists.
 *
 * The content JSON read here is the same one the text rendering parses, and
 * `localPath` resolves against `/workspace` the same way, so the two views can
 * never describe different media.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { getPendingMessages } from './db/messages-in.js';
import { extractAttachments } from './formatter.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertChat(id: string, content: object): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, content)
       VALUES (?, 'chat', ?, 'pending', ?)`,
    )
    .run(id, new Date().toISOString(), JSON.stringify(content));
}

describe('extractAttachments', () => {
  it('resolves localPath against /workspace and carries mime through', () => {
    insertChat('m1', {
      text: 'look',
      attachments: [{ type: 'image', name: 'cat.png', mimeType: 'image/png', localPath: 'inbox/m1/cat.png' }],
    });
    expect(extractAttachments(getPendingMessages())).toEqual([
      { filename: 'cat.png', mime: 'image/png', path: '/workspace/inbox/m1/cat.png', url: undefined },
    ]);
  });

  it('returns nothing for a message with no attachments', () => {
    insertChat('m1', { text: 'just words' });
    expect(extractAttachments(getPendingMessages())).toEqual([]);
  });

  it('collects across every message in the batch', () => {
    insertChat('m1', {
      text: 'a',
      attachments: [{ name: 'a.png', mimeType: 'image/png', localPath: 'inbox/m1/a.png' }],
    });
    insertChat('m2', {
      text: 'b',
      attachments: [{ name: 'b.pdf', mimeType: 'application/pdf', localPath: 'inbox/m2/b.pdf' }],
    });
    expect(extractAttachments(getPendingMessages()).map((a) => a.path)).toEqual([
      '/workspace/inbox/m1/a.png',
      '/workspace/inbox/m2/b.pdf',
    ]);
  });

  it('keeps a url-only attachment (no staged file) so the provider can decide', () => {
    insertChat('m1', { text: 'link', attachments: [{ name: 'remote.png', url: 'https://example.test/remote.png' }] });
    expect(extractAttachments(getPendingMessages())).toEqual([
      { filename: 'remote.png', mime: undefined, path: undefined, url: 'https://example.test/remote.png' },
    ]);
  });

  it('prefers the host-sanitized name over raw filename, and mimeType over mime', () => {
    insertChat('m1', {
      text: 'both',
      attachments: [
        {
          filename: 'raw-from-channel.png',
          name: 'host-sanitized.png',
          mimeType: 'image/png',
          mime: 'image/jpeg',
          localPath: 'inbox/m1/host-sanitized.png',
        },
      ],
    });
    expect(extractAttachments(getPendingMessages())).toEqual([
      {
        filename: 'host-sanitized.png',
        mime: 'image/png',
        path: '/workspace/inbox/m1/host-sanitized.png',
        url: undefined,
      },
    ]);
  });

  it('accepts the alternate name/mime spellings an adapter may use', () => {
    insertChat('m1', {
      text: 'alt',
      attachments: [{ name: 'doc.pdf', mime: 'application/pdf', localPath: 'inbox/m1/doc.pdf' }],
    });
    expect(extractAttachments(getPendingMessages())).toEqual([
      { filename: 'doc.pdf', mime: 'application/pdf', path: '/workspace/inbox/m1/doc.pdf', url: undefined },
    ]);
  });

  it('skips an attachment with neither a staged file nor a url', () => {
    insertChat('m1', {
      text: 'unfetchable',
      attachments: [
        { name: 'ghost.png', mimeType: 'image/png' },
        { name: 'real.png', mimeType: 'image/png', localPath: 'inbox/m1/real.png' },
      ],
    });
    expect(extractAttachments(getPendingMessages()).map((a) => a.filename)).toEqual(['real.png']);
  });

  it('skips a null or non-object element instead of throwing on the whole batch', () => {
    insertChat('m1', {
      text: 'ragged',
      attachments: [null, 'cat.png', 42, { name: 'cat.png', mimeType: 'image/png', localPath: 'inbox/m1/cat.png' }],
    });
    let attachments: ReturnType<typeof extractAttachments> = [];
    expect(() => {
      attachments = extractAttachments(getPendingMessages());
    }).not.toThrow();
    expect(attachments).toEqual([
      { filename: 'cat.png', mime: 'image/png', path: '/workspace/inbox/m1/cat.png', url: undefined },
    ]);
  });

  it('ignores an attachments field that is not an array', () => {
    insertChat('m1', { text: 'bad shape', attachments: { name: 'cat.png' } });
    expect(extractAttachments(getPendingMessages())).toEqual([]);
  });

  it('survives content that is not JSON at all', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES (?, 'chat', ?, 'pending', ?)`,
      )
      .run('m1', new Date().toISOString(), 'plain text, not json');
    expect(extractAttachments(getPendingMessages())).toEqual([]);
  });
});
