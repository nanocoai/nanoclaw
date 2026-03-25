import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

// Mock sharp
vi.mock('sharp', () => {
  const mockSharp = vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('resized-image-data')),
  }));
  return { default: mockSharp };
});

vi.mock('fs');

import { processImage, parseImageReferences, isImageMessage } from './image.js';

describe('image processing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  });

  describe('isImageMessage', () => {
    it('returns true for image messages', () => {
      const msg = { message: { imageMessage: { mimetype: 'image/jpeg' } } };
      expect(isImageMessage(msg as any)).toBe(true);
    });

    it('returns false for non-image messages', () => {
      const msg = { message: { conversation: 'hello' } };
      expect(isImageMessage(msg as any)).toBe(false);
    });

    it('returns false for null message', () => {
      const msg = { message: null };
      expect(isImageMessage(msg as any)).toBe(false);
    });
  });

  describe('processImage', () => {
    it('resizes and saves image, returns content string', async () => {
      const buffer = Buffer.from('raw-image-data');
      const result = await processImage(buffer, '/tmp/groups/test', 'Check this out');

      expect(result).not.toBeNull();
      expect(result!.content).toMatch(/^\[Image: attachments\/img-\d+-[a-z0-9]+\.jpg\] Check this out$/);
      expect(result!.relativePath).toMatch(/^attachments\/img-\d+-[a-z0-9]+\.jpg$/);
      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('returns content without caption when none provided', async () => {
      const buffer = Buffer.from('raw-image-data');
      const result = await processImage(buffer, '/tmp/groups/test', '');

      expect(result).not.toBeNull();
      expect(result!.content).toMatch(/^\[Image: attachments\/img-\d+-[a-z0-9]+\.jpg\]$/);
    });

    it('returns null on empty buffer', async () => {
      const result = await processImage(Buffer.alloc(0), '/tmp/groups/test', '');

      expect(result).toBeNull();
    });
  });

  describe('parseImageReferences', () => {
    it('extracts image paths from message content', () => {
      const messages = [
        { content: '[Image: attachments/img-123.jpg] hello' },
        { content: 'plain text' },
        { content: '[Image: attachments/img-456.jpg]' },
      ];
      const refs = parseImageReferences(messages as any);

      expect(refs).toEqual([
        { relativePath: 'attachments/img-123.jpg', mediaType: 'image/jpeg' },
        { relativePath: 'attachments/img-456.jpg', mediaType: 'image/jpeg' },
      ]);
    });

    it('returns empty array when no images', () => {
      const messages = [{ content: 'just text' }];
      expect(parseImageReferences(messages as any)).toEqual([]);
    });
  });
});
