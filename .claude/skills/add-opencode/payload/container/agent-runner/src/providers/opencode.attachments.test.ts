import { afterEach, describe, expect, it } from 'bun:test';

import {
  buildAttachmentFileParts,
  buildPromptParts,
  resolveNativeAttachmentLimits,
  type NativeAttachmentFileInfo,
  type NativeAttachmentLimits,
} from './opencode.js';

const PRESENT = new Map<string, number>([
  ['/workspace/inbox/msg-1/cat.png', 1_024],
  ['/workspace/inbox/msg-1/report.pdf', 2_048],
  ['/workspace/inbox/msg-1/blob', 128],
  ['/workspace/inbox/msg-1/second.png', 3_072],
]);
const inspect = (filePath: string): NativeAttachmentFileInfo | null => {
  const size = PRESENT.get(filePath);
  return size === undefined ? null : { realPath: filePath, size };
};
const generous: NativeAttachmentLimits = { maxCount: 8, maxBytes: 25 * 1024 * 1024 };

function attachment(filename: string, mime: string | undefined, sourceMessageId = 'msg-1') {
  return {
    sourceMessageId,
    filename,
    ...(mime ? { mime } : {}),
    path: `/workspace/inbox/${sourceMessageId}/${filename}`,
  };
}

afterEach(() => {
  delete process.env.OPENCODE_NATIVE_ATTACHMENT_MAX_COUNT;
  delete process.env.OPENCODE_NATIVE_ATTACHMENT_MAX_BYTES;
});

describe('buildAttachmentFileParts', () => {
  it('sends a message-bound image as a file part', () => {
    expect(buildAttachmentFileParts([attachment('cat.png', 'image/png')], inspect, generous)).toEqual([
      {
        type: 'file',
        mime: 'image/png',
        filename: 'msg-1--cat.png',
        url: 'file:///workspace/inbox/msg-1/cat.png',
      },
    ]);
  });

  it('sends a PDF and falls back to a recognized extension', () => {
    const parts = buildAttachmentFileParts(
      [attachment('report.pdf', 'application/pdf'), attachment('cat.png', undefined)],
      inspect,
      generous,
    );
    expect(parts.map((part) => part.mime)).toEqual(['application/pdf', 'image/png']);
  });

  it('rejects a path outside the source message inbox even when it exists', () => {
    const forged = {
      sourceMessageId: 'msg-1',
      filename: 'cat.png',
      mime: 'image/png',
      path: '/workspace/agent/cat.png',
    };
    const forgedInspect = (): NativeAttachmentFileInfo => ({ realPath: '/workspace/agent/cat.png', size: 10 });
    expect(buildAttachmentFileParts([forged], forgedInspect, generous)).toEqual([]);
  });

  it('rejects a symlink/escape reported by filesystem inspection', () => {
    const escapedInspect = (): NativeAttachmentFileInfo => ({ realPath: '/workspace/agent/private.pdf', size: 10 });
    expect(buildAttachmentFileParts([attachment('report.pdf', 'application/pdf')], escapedInspect, generous)).toEqual(
      [],
    );
  });

  it('skips missing and non-media files', () => {
    expect(
      buildAttachmentFileParts(
        [
          attachment('gone.png', 'image/png', 'msg-9'),
          attachment('cat.png', 'text/plain'),
          attachment('blob', undefined),
        ],
        inspect,
        generous,
      ),
    ).toEqual([]);
  });

  it('enforces count and actual total-byte limits', () => {
    const files = [attachment('cat.png', 'image/png'), attachment('second.png', 'image/png')];
    expect(buildAttachmentFileParts(files, inspect, { maxCount: 1, maxBytes: 10_000 })).toHaveLength(1);
    expect(buildAttachmentFileParts(files, inspect, { maxCount: 8, maxBytes: 3_000 })).toHaveLength(1);
    expect(buildAttachmentFileParts(files, inspect, { maxCount: 8, maxBytes: 500 })).toEqual([]);
  });

  it('uses safe defaults and accepts positive environment overrides', () => {
    expect(resolveNativeAttachmentLimits()).toEqual({ maxCount: 8, maxBytes: 25 * 1024 * 1024 });
    process.env.OPENCODE_NATIVE_ATTACHMENT_MAX_COUNT = '3';
    process.env.OPENCODE_NATIVE_ATTACHMENT_MAX_BYTES = '4096';
    expect(resolveNativeAttachmentLimits()).toEqual({ maxCount: 3, maxBytes: 4096 });
  });

  it('ignores invalid environment overrides', () => {
    process.env.OPENCODE_NATIVE_ATTACHMENT_MAX_COUNT = '0';
    process.env.OPENCODE_NATIVE_ATTACHMENT_MAX_BYTES = '25mb';
    expect(resolveNativeAttachmentLimits()).toEqual({ maxCount: 8, maxBytes: 25 * 1024 * 1024 });
  });
});

describe('buildPromptParts', () => {
  it('carries native media on opening and follow-up prompt construction', () => {
    expect(buildPromptParts('what is this?', [attachment('cat.png', 'image/png')], inspect, generous)).toEqual([
      { type: 'text', text: 'what is this?' },
      {
        type: 'file',
        mime: 'image/png',
        filename: 'msg-1--cat.png',
        url: 'file:///workspace/inbox/msg-1/cat.png',
      },
    ]);
  });

  it('stays text-only when there are no accepted attachments', () => {
    expect(buildPromptParts('just words', undefined, inspect, generous)).toEqual([
      { type: 'text', text: 'just words' },
    ]);
  });
});
