import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// groupFolderExistsOnDisk reads GROUPS_DIR — point it at a temp root so the
// polarity tests control what is on disk. resolveGroupFolderPath assertions
// below only check the `groups/<folder>` suffix, so they hold either way.
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, GROUPS_DIR: '/tmp/nanoclaw-test-group-folder/groups' };
});

import { groupFolderExistsOnDisk, isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';

const TEST_ROOT = '/tmp/nanoclaw-test-group-folder';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}family-chat`)).toBe(true);
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
  });
});

describe('groupFolderExistsOnDisk', () => {
  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(GROUPS_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('is true when groups/<folder> is present in any form', () => {
    fs.mkdirSync(path.join(GROUPS_DIR, 'residue-dir'));
    expect(groupFolderExistsOnDisk('residue-dir')).toBe(true);
    // A plain file counts too — presence, not shape, is the rule.
    fs.writeFileSync(path.join(GROUPS_DIR, 'residue-file'), '');
    expect(groupFolderExistsOnDisk('residue-file')).toBe(true);
  });

  it('is true for a dangling symlink — the probe must not follow links', () => {
    // A symlink whose target is gone still occupies groups/<folder> (mkdir
    // would EEXIST) and still resolves reads through whatever reappears at
    // the target. existsSync follows the link and reports absent; the
    // docstring's "any form" requires lstat semantics.
    fs.symlinkSync(path.join(TEST_ROOT, 'no-such-target'), path.join(GROUPS_DIR, 'residue-link'));
    expect(fs.existsSync(path.join(GROUPS_DIR, 'residue-link'))).toBe(false); // precondition: link is dangling
    expect(groupFolderExistsOnDisk('residue-link')).toBe(true);
  });

  it('is false when the folder is absent', () => {
    expect(groupFolderExistsOnDisk('never-created')).toBe(false);
  });

  it('throws when the name escapes the groups dir', () => {
    expect(() => groupFolderExistsOnDisk('../../etc')).toThrow(/escapes/);
  });
});
