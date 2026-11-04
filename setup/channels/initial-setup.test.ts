import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { otherChannelDiagnostic } from './initial-setup.js';

describe('otherChannelDiagnostic', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

  function checkoutWith(...skills: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'other-channel-'));
    roots.push(root);
    for (const s of skills) {
      mkdirSync(join(root, '.claude/skills', s), { recursive: true });
      writeFileSync(join(root, '.claude/skills', s, 'SKILL.md'), `# ${s}\n`);
    }
    return root;
  }

  it('keeps a name this checkout ships an add- skill for', () => {
    expect(otherChannelDiagnostic('matrix', checkoutWith('add-matrix'))).toBe('matrix');
  });

  it('sends unknown for anything else the operator typed', () => {
    const root = checkoutWith('add-matrix');
    for (const typed of ['zulip', 'my company chat', '/Users/someone/bot', '../add-matrix', 'Matrix', '']) {
      expect(otherChannelDiagnostic(typed, root)).toBe('unknown');
    }
  });

  it('needs a SKILL.md, not just a folder', () => {
    const root = checkoutWith();
    mkdirSync(join(root, '.claude/skills/add-zulip'), { recursive: true });
    expect(otherChannelDiagnostic('zulip', root)).toBe('unknown');
  });
});
