import { describe, expect, it } from 'vitest';

import {
  areaOf,
  groupByArea,
  relativeToArea,
  parseDivergences,
  parseLedger,
  parseNameStatus,
  parseNumstat,
} from './inventory.js';

describe('parseNameStatus', () => {
  it('keeps the new path of renames and drops excluded trees', () => {
    const output = [
      'A\tsrc/local/a.ts',
      'R087\told.ts\tnew.ts',
      'M\tgroups/x/CLAUDE.md',
      'A\t.nanoclaw-contrib/ledger.md',
      'M\tsrc/index.ts',
      '',
    ].join('\n');
    expect(parseNameStatus(output)).toEqual([
      { status: 'A', path: 'src/local/a.ts' },
      { status: 'R', path: 'new.ts' },
      { status: 'M', path: 'src/index.ts' },
    ]);
  });

  it('drops caller-supplied prefixes too', () => {
    expect(parseNameStatus('A\tnotes/a.md\nA\tsrc/a.ts\n', ['notes/'])).toEqual([{ status: 'A', path: 'src/a.ts' }]);
  });
});

describe('parseNumstat', () => {
  it('treats binary markers as zero', () => {
    expect(parseNumstat('12\t3\tsrc/a.ts\n-\t-\timg.png\n')).toEqual([
      { path: 'src/a.ts', added: 12, removed: 3 },
      { path: 'img.png', added: 0, removed: 0 },
    ]);
  });
});

describe('parseDivergences', () => {
  it('reads D-numbered level-two headings', () => {
    const markdown = '# Divergences\n## D1 — Credential lane\ntext\n## D12 - Bun tests in CI\n### D9 nested\n';
    expect(parseDivergences(markdown)).toEqual([
      { id: 'D1', title: 'Credential lane' },
      { id: 'D12', title: 'Bun tests in CI' },
    ]);
  });
});

describe('parseLedger with a row-number column', () => {
  it('finds the slug cell after a leading # column', () => {
    const markdown = [
      '| # | Slug | Feature | Route | Decision | Decided | Branch | Status |',
      '|---|---|---|---|---|---|---|---|',
      '| 1 | `turn-hooks` | Turn hooks | seam | contribute | 2026-01-15 | contrib/turn-hooks | pr-open |',
    ].join('\n');
    expect(parseLedger(markdown)).toEqual([{ slug: 'turn-hooks', decision: 'contribute', status: 'pr-open' }]);
  });
});

describe('parseLedger', () => {
  it('reads slug, decision and status from ledger rows only', () => {
    const markdown = [
      '| Slug | Feature | Route | Decision | Decided | Branch | Status |',
      '|---|---|---|---|---|---|---|',
      '| `turn-hooks` | Turn hooks | seam | contribute | 2026-01-15 | contrib/turn-hooks | pr-open |',
      '| `branding` | Branding | skill | keep-local | 2026-01-15 | | |',
    ].join('\n');
    expect(parseLedger(markdown)).toEqual([
      { slug: 'turn-hooks', decision: 'contribute', status: 'pr-open' },
      { slug: 'branding', decision: 'keep-local', status: '' },
    ]);
  });
});

describe('areaOf / groupByArea', () => {
  it('uses deeper areas for container paths and root for top-level files', () => {
    expect(areaOf('container/agent-runner/src/local/tts/x.ts')).toBe('container/agent-runner/src/local');
    expect(areaOf('src/local/x.ts')).toBe('src/local');
    expect(areaOf('src/x.ts')).toBe('src');
    expect(areaOf('.prettierignore')).toBe('(root)');
  });

  it('keeps root-level paths whole', () => {
    expect(relativeToArea('(root)', '.prettierignore')).toBe('.prettierignore');
    expect(relativeToArea('src/local', 'src/local/db/a.ts')).toBe('db/a.ts');
  });

  it('sorts areas by file count, largest first', () => {
    const groups = groupByArea(['src/a.ts', 'web/src/a.ts', 'web/src/b.ts']);
    expect([...groups.keys()]).toEqual(['web/src', 'src']);
  });
});
