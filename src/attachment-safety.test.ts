import { describe, expect, it } from 'vitest';

import { isSafeAttachmentName, safeAttachmentDirName } from './attachment-safety.js';

describe('isSafeAttachmentName', () => {
  it('rejects Google Chat-style resource-path message ids', () => {
    expect(isSafeAttachmentName('spaces/AAAABBBBCCC/messages/AbCdEfGhIjk.AbCdEfGhIjk')).toBe(false);
  });

  it('rejects traversal and empty/non-string values', () => {
    expect(isSafeAttachmentName('../../escape')).toBe(false);
    expect(isSafeAttachmentName('..')).toBe(false);
    expect(isSafeAttachmentName('')).toBe(false);
  });

  it('accepts opaque single-component ids used by Slack/Discord/WhatsApp', () => {
    expect(isSafeAttachmentName('msg-1700000000000-abc123')).toBe(true);
  });
});

describe('safeAttachmentDirName', () => {
  it('passes already-safe ids through unchanged', () => {
    expect(safeAttachmentDirName('msg-1700000000000-abc123')).toBe('msg-1700000000000-abc123');
  });

  it('derives a single safe path component for a Google Chat resource path', () => {
    const id = 'spaces/AAAABBBBCCC/messages/AbCdEfGhIjk.AbCdEfGhIjk';
    const derived = safeAttachmentDirName(id);
    expect(isSafeAttachmentName(derived)).toBe(true);
    expect(derived).not.toContain('/');
  });

  it('derives a safe component for a traversal-shaped id without reproducing `..`', () => {
    const derived = safeAttachmentDirName('../../escape');
    expect(isSafeAttachmentName(derived)).toBe(true);
    expect(derived).not.toContain('..');
    expect(derived).not.toContain('/');
  });

  it('is deterministic for the same id', () => {
    const id = 'spaces/AAAABBBBCCC/messages/AbCdEfGhIjk.AbCdEfGhIjk';
    expect(safeAttachmentDirName(id)).toBe(safeAttachmentDirName(id));
  });

  it('does not collide two unsafe ids that sanitize to the same slug', () => {
    const a = safeAttachmentDirName('spaces/AAA/messages/BBB');
    const b = safeAttachmentDirName('spaces\\AAA\\messages\\BBB');
    expect(a).not.toBe(b);
  });
});
