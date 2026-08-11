import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { PERSONA_PREPEND_FILE, readGroupPersona, stageGroupPersona } from './group-persona.js';
import { log } from './log.js';

const TMP = '/tmp/nanoclaw-group-persona-test';

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('readGroupPersona', () => {
  it('returns null when the prepend file is absent', () => {
    expect(readGroupPersona(TMP)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('returns null for an empty / whitespace-only file', () => {
    fs.writeFileSync(path.join(TMP, PERSONA_PREPEND_FILE), '  \n\n');
    expect(readGroupPersona(TMP)).toBeNull();
  });

  it('combines instructions first and remaining prepend files alphabetically', () => {
    fs.writeFileSync(path.join(TMP, 'tools.prepend.md'), '\nTools instructions.\n');
    fs.writeFileSync(path.join(TMP, PERSONA_PREPEND_FILE), '\nYou are an SDR agent.\n\n');
    fs.writeFileSync(path.join(TMP, 'behavior.prepend.md'), 'Behavior instructions.\n');
    fs.writeFileSync(path.join(TMP, 'ignored.md'), 'Not prepended.\n');

    expect(readGroupPersona(TMP)).toBe('You are an SDR agent.\n\nBehavior instructions.\n\nTools instructions.');
  });

  it('skips a symlink without dropping valid prepend files', () => {
    const target = path.join(TMP, 'outside.md');
    fs.writeFileSync(target, 'host-only content\n');
    fs.symlinkSync(target, path.join(TMP, PERSONA_PREPEND_FILE));
    fs.writeFileSync(path.join(TMP, 'tools.prepend.md'), 'Safe tools.\n');

    expect(readGroupPersona(TMP)).toBe('Safe tools.');
    expect(log.warn).toHaveBeenCalledWith(
      'Could not read group standing instructions; omitting prepend file',
      expect.objectContaining({ file: path.join(TMP, PERSONA_PREPEND_FILE) }),
    );
  });

  it('omits prepends when the group directory cannot be read', () => {
    fs.rmSync(TMP, { recursive: true });
    fs.writeFileSync(TMP, 'not a directory');

    expect(readGroupPersona(TMP)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      'Could not enumerate group standing instructions; omitting prepend files',
      expect.objectContaining({ groupDir: TMP }),
    );
  });
});

describe('stageGroupPersona', () => {
  it('creates standing instructions once', () => {
    expect(stageGroupPersona(TMP, 'You are concise.\n\n')).toBe(true);
    expect(stageGroupPersona(TMP, 'replacement')).toBe(false);
    expect(fs.readFileSync(path.join(TMP, PERSONA_PREPEND_FILE), 'utf-8')).toBe('You are concise.\n');
  });

  it('does not replace an existing symlink', () => {
    const target = path.join(TMP, 'target.md');
    fs.writeFileSync(target, 'keep me\n');
    fs.symlinkSync(target, path.join(TMP, PERSONA_PREPEND_FILE));

    expect(stageGroupPersona(TMP, 'replacement')).toBe(false);
    expect(fs.readFileSync(target, 'utf-8')).toBe('keep me\n');
  });
});
