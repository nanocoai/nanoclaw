import { describe, expect, it } from 'vitest';

import {
  anchorAlternation,
  buildRules,
  firstGroupIsPart,
  goSamples,
  issuerPrefixes,
  parseToml,
  re2ToJs,
  rot135,
  sampleTemplates,
  skipReason,
} from './gen-secret-rules.js';

const js = (re2: string): RegExp => {
  const { source, flags } = re2ToJs(re2);
  return new RegExp(source, flags);
};

describe('parseToml', () => {
  it('reads tables, nested arrays of tables, strings, numbers and multi-line arrays', () => {
    const doc = parseToml(
      [
        'title = "gitleaks config" # comment',
        '[allowlist]',
        "regexes = ['''^a$''', '''b''',]",
        '[[rules]]',
        'id = "one"',
        "regex = '''x\\d+'''",
        'entropy = 3.5',
        'keywords = [',
        '    "k1", # first',
        '    "k2",',
        ']',
        '[[rules.allowlists]]',
        'stopwords = ["s"]',
        '[[rules]]',
        'id = "two\\u0021"',
      ].join('\n'),
    );
    expect(doc.title).toBe('gitleaks config');
    expect(doc.allowlist).toEqual({ regexes: ['^a$', 'b'] });
    expect(doc.rules).toEqual([
      { id: 'one', regex: 'x\\d+', entropy: 3.5, keywords: ['k1', 'k2'], allowlists: [{ stopwords: ['s'] }] },
      { id: 'two!' },
    ]);
  });
});

describe('re2ToJs', () => {
  it('uses the i flag when a pattern is case-insensitive throughout', () => {
    expect(re2ToJs('(?i)abc[a-z]')).toEqual({ source: 'abc[a-z]', flags: 'i' });
  });

  it('folds case by hand where (?i) starts part-way or (?-i:) turns it off', () => {
    const re = js('\\b(p8e-(?i)[a-z0-9]{4})');
    expect(re.test('p8e-AbC1')).toBe(true);
    expect(re.test('P8E-abc1')).toBe(false);
    const mixed = js('(?i)key(?-i:AB)');
    expect(mixed.test('KEYAB')).toBe(true);
    expect(mixed.test('keyab')).toBe(false);
  });

  it('maps RE2-only syntax', () => {
    expect(js('a\\z').test('xa')).toBe(true);
    expect(js('a\\z').test('ab')).toBe(false);
    expect(js('^[[:alnum:]]+$').test('aZ9')).toBe(true);
    expect(js('^[]a]+$').test(']a')).toBe(true);
    expect(js('(?P<alg>x)y').exec('xy')?.groups?.alg).toBe('x');
    expect(js('(?s:a.b)').test('a\nb')).toBe(true);
    expect(js('a.b').test('a\nb')).toBe(false);
  });

  it('caps a .* run and stops . at \\r, so a backtracking engine stays linear', () => {
    expect(re2ToJs('curl.*?-H').source).toBe('curl[^\\r\\n]{0,1000}?-H');
    expect(js('a.*b').test(`a${'x'.repeat(999)}b`)).toBe(true);
    expect(js('a.b').test('a\rb')).toBe(false);
  });

  it('flags a first capture group that is only part of the key', () => {
    expect(firstGroupIsPart('\\bZXlK(?:(?<alg>a)|(?<b>c))x')).toBe(true);
    expect(firstGroupIsPart('x/[a-z0-9]{8}-([a-z0-9]{4}-){3}y')).toBe(true);
    expect(firstGroupIsPart('(?:k)[\\s(]{0,3}([a-z]{8})')).toBe(false);
    expect(firstGroupIsPart('\\b((live|test)_[a-f0-9]{35})')).toBe(false);
  });

  it('throws on syntax it cannot map', () => {
    expect(() => re2ToJs('\\pL')).toThrow();
    expect(() => re2ToJs('(?m)^a')).toThrow();
  });
});

describe('issuerPrefixes', () => {
  it('keeps keywords that are fixed text at the start of every key', () => {
    expect(issuerPrefixes('ghp_[0-9a-zA-Z]{36}', ['ghp_'], false)).toEqual(['ghp_']);
    expect(issuerPrefixes('\\b((?:A3T[A-Z0-9]|AKIA|ASIA)[A-Z2-7]{16})\\b', ['a3t', 'akia', 'asia'], false)).toEqual([
      'akia',
      'asia',
      'a3t',
    ]);
  });

  it('drops keywords that only name the key or sit inside it', () => {
    const atlassian = '(?:(?:JIRA|[Jj]ira))[ =]{0,3}([a-z0-9]{24})|\\b(ATATT3[A-Za-z0-9]{186})';
    expect(issuerPrefixes(atlassian, ['jira', 'atatt3'], false)).toEqual(['atatt3']);
    expect(issuerPrefixes('\\b([a-z0-9]{14}\\.(?:atlasv1)\\.[a-z0-9]{60})', ['atlasv1'], false)).toEqual([]);
    expect(issuerPrefixes('\\b(ey[a-z]{17,})', ['ey'], false)).toEqual([]);
  });
});

describe('rot135', () => {
  it('rotates letters by 13 and digits by 5, so applying it twice gives the text back', () => {
    expect(rot135('AKIA09az-_.')).toBe('NXVN54nm-_.');
    expect(rot135(rot135('glpat-Ab3Cd4Ef5'))).toBe('glpat-Ab3Cd4Ef5');
  });
});

describe('anchorAlternation', () => {
  it('anchors every alternative of an allowlist, not just the first and last', () => {
    expect(anchorAlternation('(?i)^true|false|null$')).toBe('(?i)^(?:true|false|null)$');
    expect(anchorAlternation('^\\$(?:\\d+|{\\d+})$')).toBe('^\\$(?:\\d+|{\\d+})$');
    expect(anchorAlternation('a|b')).toBe('a|b');
  });
});

describe('buildRules', () => {
  it('skips generic and path rules, ports the rest and widens the token end', () => {
    expect(skipReason({ id: 'generic-api-key', regex: 'x' })).toMatch(/generic/);
    expect(skipReason({ id: 'adobe-client-id', regex: 'x' })).toMatch(/client id/);
    expect(skipReason({ id: 'pkcs12-file', path: 'p12$' })).toMatch(/path/);
    const build = buildRules({
      rules: [
        { id: 'generic-api-key', regex: 'x', keywords: ['x'] },
        {
          id: 'demo',
          regex: '(?i)[\\w.-]{0,50}?(?:demo)[ =]{0,3}([a-z0-9]{8})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
          keywords: ['DEMO'],
          entropy: 2,
          allowlists: [{ condition: 'AND', paths: ['x$'], regexes: ['y'] }, { regexes: ['^demo0000$'] }],
        },
      ],
    });
    expect(build.skipped).toEqual([
      ['generic-api-key', 'generic: any long value after a word like key, token or secret'],
    ]);
    const [rule] = build.rules;
    expect(rule.keywords).toEqual(['demo']);
    expect(rule.allowlists).toEqual([{ target: 'secret', regexes: [['^demo0000$', '']] }]);
    const re = new RegExp(rule.regex[0], rule.regex[1]);
    expect(rule.regex[0].startsWith('(?:demo)')).toBe(true);
    expect(re.exec('?demo=ab12cd34&x=1')?.[1]).toBe('ab12cd34');
  });
});

describe('goSamples', () => {
  const templates = sampleTemplates(
    'package utils\nfunc GenerateSampleSecrets(identifier string, secret string) []string {\n' +
      '\tsamples := map[string]string{\n\t\t"a": "{i}Token={s}", // x\n\t\t"b": `{I}_TOKEN: "{s}"`,\n\t}\n\treturn nil\n}\n',
  );

  it('reads the GenerateSampleSecrets templates', () => {
    expect(templates).toEqual(['{i}Token={s}', '{I}_TOKEN: "{s}"']);
  });

  it('keeps literal samples and helper calls with literal arguments, and counts the random ones', () => {
    const src = `package rules
func Demo() *config.Rule {
	r := config.Rule{
		RuleID: "demo",
		Keywords: []string{"demo"},
	}
	tps := []string{
		"demo=abc" + "def", // literal, joined
		utils.GenerateSampleSecret("demo", "s3cr3t"),
		secrets.NewSecret(utils.Hex("32")),
	}
	tps = append(tps, utils.GenerateSampleSecrets("demo", "lit")...)
	fps := []string{\`demo=\\n\`}
	return utils.Validate(r, tps, fps)
}
`;
    expect(goSamples(src).get('demo')).toEqual({
      tp: ['demo=abcdef', 'demo_api_token = "s3cr3t"', ['demo', 'lit']],
      fp: ['demo=\\n'],
      skipped: 1,
    });
  });

  it('does not let a brace inside a string end a function early', () => {
    const src = `package rules
func A() *config.Rule {
	r := config.Rule{RuleID: "a"}
	tps := []string{"{"}
	return utils.Validate(r, tps, nil)
}
func B() *config.Rule {
	r := config.Rule{RuleID: "b"}
	tps := []string{"}"}
	return utils.Validate(r, tps, nil)
}
`;
    const samples = goSamples(src);
    expect(samples.get('a')?.tp).toEqual(['{']);
    expect(samples.get('b')?.tp).toEqual(['}']);
  });
});
