import { describe, expect, it } from 'vitest';

import {
  addedLinesByFile,
  BUILTIN_RULES,
  maskMatch,
  parseDenylist,
  scanText,
  unapprovedIdentities,
} from './scrub-check.js';

describe('parseDenylist', () => {
  it('skips comments and blanks, escapes plain terms, keeps regex entries', () => {
    const rules = parseDenylist('# internal\n\nacme.example\n/team-[a-z]+/i\n');
    expect(rules).toHaveLength(2);
    expect(rules[0].pattern.test('host.ACME.example')).toBe(true);
    expect(rules[0].pattern.flags).toContain('i');
    expect(rules[1].pattern.flags).toContain('g');
    expect('team-red'.match(rules[1].pattern)).toEqual(['team-red']);
  });

  it('plain terms do not act as regex', () => {
    const [rule] = parseDenylist('a.b');
    expect('axb'.match(rule.pattern)).toBeNull();
  });
});

describe('scanText', () => {
  it('reports rule, line and match for built-in leaks', () => {
    // Leak shapes are assembled at runtime so this file passes its own scrub check.
    const homePath = ['', 'Users', 'alice', 'x'].join('/');
    const privateIp = [10, 1, 2, 3].join('.');
    const findings = scanText('f.ts', `ok\nconst home = "${homePath}";\nip ${privateIp}`, BUILTIN_RULES);
    expect(findings.map((f) => [f.line, f.rule])).toEqual([
      [2, 'home-path'],
      [3, 'private-ip'],
    ]);
  });

  it('ignores allowed matches', () => {
    const text = 'Co-Authored-By: x <noreply@anthropic.com>\nuser@example.com\n/home/node/.claude';
    expect(scanText('f', text, BUILTIN_RULES)).toEqual([]);
  });

  it('applies denylist rules alongside built-ins', () => {
    const findings = scanText('f', 'calls Acme-Gateway', parseDenylist('acme-gateway'));
    expect(findings).toHaveLength(1);
    expect(findings[0].match).toBe('Acme-Gateway');
  });

  it('detects credential shapes', () => {
    const text = `key=sk-${'a'.repeat(24)} token=ghp_${'b'.repeat(36)}`;
    expect(scanText('f', text, BUILTIN_RULES).map((f) => f.rule)).toEqual(['anthropic-or-openai-key', 'github-token']);
  });
});

describe('addedLinesByFile', () => {
  it('keeps only added lines per file and skips deletions', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1,2 @@',
      '-old',
      '+new one',
      '+new two',
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '-removed',
    ].join('\n');
    expect([...addedLinesByFile(diff)]).toEqual([['src/a.ts', 'new one\nnew two']]);
  });
});

describe('maskMatch', () => {
  it('keeps two chars at each end', () => {
    expect(maskMatch('secretvalue')).toBe('se*******ue');
    expect(maskMatch('abc')).toBe('***');
  });
});

describe('unapprovedIdentities', () => {
  it('blanks lines whose email is approved and keeps line numbers stable', () => {
    const lines = 'Owner <owner@example.org>\nOther <someone@example.net>\nOWNER <Owner@Example.org>';
    expect(unapprovedIdentities(lines, ['owner@example.org'])).toBe('\nOther <someone@example.net>\n');
  });
});
