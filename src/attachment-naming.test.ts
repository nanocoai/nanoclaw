import { describe, it, expect } from 'vitest';

import { deriveAttachmentName, extForMime } from './attachment-naming.js';

describe('extForMime', () => {
  it('returns empty for undefined / non-string / empty', () => {
    expect(extForMime(undefined)).toBe('');
    expect(extForMime('')).toBe('');
    expect(extForMime({})).toBe('');
    expect(extForMime(null)).toBe('');
    expect(extForMime(42)).toBe('');
  });

  it('maps common MIME types to canonical extensions', () => {
    expect(extForMime('image/jpeg')).toBe('jpg');
    expect(extForMime('application/pdf')).toBe('pdf');
    expect(extForMime('audio/ogg')).toBe('ogg');
  });

  it('strips parameters and is case-insensitive', () => {
    expect(extForMime('image/JPEG; foo=bar')).toBe('jpg');
    expect(extForMime('  Application/PDF  ')).toBe('pdf');
    expect(extForMime('text/plain; charset=utf-8')).toBe('txt');
  });

  it('returns empty for unknown MIMEs', () => {
    expect(extForMime('application/octet-stream')).toBe('');
    expect(extForMime('application/x-totally-made-up')).toBe('');
  });
});

describe('deriveAttachmentName', () => {
  it('returns explicit name when set, no derivation', () => {
    expect(deriveAttachmentName({ name: 'photo.jpg', mimeType: 'application/pdf' })).toBe('photo.jpg');
  });

  it('ignores empty / non-string explicit name and falls through to derivation', () => {
    const out = deriveAttachmentName({ name: '', mimeType: 'application/pdf' });
    expect(out).toMatch(/^attachment-\d+\.pdf$/);

    const out2 = deriveAttachmentName({ name: 42, mimeType: 'application/pdf' });
    expect(out2).toMatch(/^attachment-\d+\.pdf$/);
  });

  it('derives extension from mimeType when no name', () => {
    expect(deriveAttachmentName({ mimeType: 'application/pdf' })).toMatch(/^attachment-\d+\.pdf$/);
    expect(deriveAttachmentName({ mimeType: 'image/jpeg' })).toMatch(/^attachment-\d+\.jpg$/);
  });

  it('falls back to att.type when mimeType is missing (Telegram photos/stickers)', () => {
    expect(deriveAttachmentName({ type: 'photo' })).toMatch(/^attachment-\d+\.jpg$/);
    expect(deriveAttachmentName({ type: 'sticker' })).toMatch(/^attachment-\d+\.webp$/);
    expect(deriveAttachmentName({ type: 'voice' })).toMatch(/^attachment-\d+\.ogg$/);
    expect(deriveAttachmentName({ type: 'animation' })).toMatch(/^attachment-\d+\.mp4$/);
  });

  it('case-insensitive att.type lookup', () => {
    expect(deriveAttachmentName({ type: 'PHOTO' })).toMatch(/^attachment-\d+\.jpg$/);
  });

  it('returns bare timestamp when nothing matches', () => {
    expect(deriveAttachmentName({})).toMatch(/^attachment-\d+$/);
    expect(deriveAttachmentName({ mimeType: 'application/octet-stream' })).toMatch(/^attachment-\d+$/);
    expect(deriveAttachmentName({ type: 'mystery-class' })).toMatch(/^attachment-\d+$/);
  });

  it('does not crash on non-string mimeType (defensive against buggy bridges)', () => {
    expect(() => deriveAttachmentName({ mimeType: { foo: 'bar' } })).not.toThrow();
    expect(deriveAttachmentName({ mimeType: { foo: 'bar' } })).toMatch(/^attachment-\d+$/);
  });
});
