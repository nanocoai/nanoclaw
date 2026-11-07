import { describe, expect, it } from 'vitest';

import { inboxFolderName, isSafeAttachmentName } from './attachment-safety.js';

const RESOURCE_PATH_ID = 'spaces/AAAABBBBCCC/messages/AbCdEfGhIjk.AbCdEfGhIjk:ag-6e9d6f1b';

describe('inboxFolderName', () => {
  it('keeps every id that is already a safe name', () => {
    for (const id of [
      'msg-ok',
      '1712345678.123456:ag-1',
      '3EB0C1D2E3F4A5B6:ag-1',
      '-1001234567890:42:ag-1',
      '$event-id:example.org:ag-1',
      'web-1784959140240-i:ag-6e9d6f1b',
      'a2a-1700000000000-abc123',
      'file with spaces',
      '.hidden',
    ]) {
      expect(inboxFolderName(id)).toBe(id);
    }
  });

  it('maps an id containing a path separator to one safe name', () => {
    const folder = inboxFolderName(RESOURCE_PATH_ID);
    expect(folder).not.toBeNull();
    expect(isSafeAttachmentName(folder!)).toBe(true);
    expect(folder).not.toContain(':');
    expect(folder).toMatch(/^~spaces-AAAABBBBCCC-messages-AbCdEfGhIjk\.AbCdEfGhIjk-ag-6e9d6f1b-[0-9a-f]{16}$/);
  });

  it('is stable for the same id', () => {
    expect(inboxFolderName(RESOURCE_PATH_ID)).toBe(inboxFolderName(RESOURCE_PATH_ID));
  });

  it('refuses traversal-shaped and absolute ids', () => {
    for (const id of [
      '',
      '.',
      '..',
      '../../escape',
      'a/../b',
      'a/./b',
      'a\\..\\b',
      '/etc/passwd',
      '\\\\server\\share',
      'C:\\Windows\\x',
      'x\0y',
    ]) {
      expect(inboxFolderName(id)).toBeNull();
    }
  });

  it('never maps two different ids to the same folder', () => {
    const encodedA = inboxFolderName('a/b')!;
    const ids = [
      'a/b',
      'a\\b',
      'a?b',
      'a:b',
      'a-b',
      'a//b',
      'a/b/',
      RESOURCE_PATH_ID,
      RESOURCE_PATH_ID.replace(':', '/'),
      // A safe id spelled exactly like another id's encoded folder.
      encodedA,
      '~plain',
      'x'.repeat(300),
      'x'.repeat(301),
    ];
    const folders = ids.map((id) => inboxFolderName(id));
    expect(folders.every((f) => f !== null && isSafeAttachmentName(f))).toBe(true);
    expect(new Set(folders).size).toBe(ids.length);
    expect(inboxFolderName(encodedA)).not.toBe(encodedA);
  });

  it('keeps folder names within the filesystem name limit', () => {
    const long = `${'é'.repeat(200)}/x`;
    for (const id of ['x'.repeat(300), long, `${'a/'.repeat(200)}b`]) {
      expect(Buffer.byteLength(inboxFolderName(id)!)).toBeLessThanOrEqual(255);
    }
    expect(inboxFolderName('x'.repeat(255))).toBe('x'.repeat(255));
  });
});
