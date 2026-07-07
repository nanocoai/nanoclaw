import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PERSONA_PREPEND_FILE, readGroupPersona } from './group-persona.js';

const TMP = '/tmp/nanoclaw-group-persona-test';

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('readGroupPersona', () => {
  it('returns null when the prepend file is absent', () => {
    expect(readGroupPersona(TMP)).toBeNull();
  });

  it('returns null for an empty / whitespace-only file', () => {
    fs.writeFileSync(path.join(TMP, PERSONA_PREPEND_FILE), '  \n\n');
    expect(readGroupPersona(TMP)).toBeNull();
  });

  it('returns the trimmed content when present', () => {
    fs.writeFileSync(path.join(TMP, PERSONA_PREPEND_FILE), '\nYou are an SDR agent.\n\n');
    expect(readGroupPersona(TMP)).toBe('You are an SDR agent.');
  });
});
