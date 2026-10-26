import { readFileSync } from 'fs';

import { describe, expect, it } from 'vitest';

import { detectSecrets, redactSecrets } from './secret-redaction.js';
import { GITLEAKS_RULES, GITLEAKS_SKIPPED } from './secret-rules.generated.js';

type Sample = string | [string, string];
const fixture = JSON.parse(readFileSync(new URL('./secret-rules.samples.generated.json', import.meta.url), 'utf8')) as {
  templates: string[];
  rules: Record<string, { tp: Sample[]; fp: Sample[] }>;
};

/** Samples are stored backwards with letters and digits rotated, then base64, so secret scanners skip the fakes. */
const rot135 = (s: string): string =>
  s.replace(/[A-Za-z0-9]/g, (c) => {
    const code = c.charCodeAt(0);
    if (code <= 57) return String.fromCharCode(((code - 48 + 5) % 10) + 48);
    const base = code <= 90 ? 65 : 97;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });
const decode = (s: string): string => [...rot135(Buffer.from(s, 'base64').toString('utf8'))].reverse().join('');
/** A sample line, or an [identifier, secret] pair spread over every template. */
const lines = (sample: Sample): string[] => {
  if (typeof sample === 'string') return [decode(sample)];
  const [id, secret] = [sample[0], decode(sample[1])];
  const fill: Record<string, string> = { '{i}': id, '{I}': id.toUpperCase(), '{s}': secret };
  return fixture.templates.map((t) => t.replace(/\{[iIs]\}/g, (m) => fill[m]));
};

describe("gitleaks rules: the rule sources' own samples", () => {
  it.each(Object.entries(fixture.rules))('%s', (id, samples) => {
    const only = new Set([id]);
    const missed = samples.tp.flatMap(lines).filter((line) => detectSecrets(line, only).length === 0);
    const flagged = samples.fp.flatMap(lines).filter((line) => detectSecrets(line, only).length > 0);
    expect(missed).toEqual([]);
    expect(flagged).toEqual([]);
  });

  it('covers the rules that have literal samples', () => {
    expect(Object.keys(fixture.rules).length).toBeGreaterThanOrEqual(80);
  });
});

describe('gitleaks rules: the list', () => {
  it('leaves out the generic rule and path-only rules', () => {
    expect(GITLEAKS_SKIPPED['generic-api-key']).toBeDefined();
    expect(GITLEAKS_SKIPPED['pkcs12-file']).toBeDefined();
    expect(GITLEAKS_RULES.map((r) => r.id)).not.toContain('generic-api-key');
    expect(GITLEAKS_RULES.length).toBeGreaterThan(200);
  });

  it('gates every rule on keywords of 2 or more characters', () => {
    for (const r of GITLEAKS_RULES) {
      expect(r.keywords.length, r.id).toBeGreaterThan(0);
      for (const k of r.keywords) expect(k.length, r.id).toBeGreaterThanOrEqual(2);
    }
  });

  // gitleaks writes its rules for Go's linear-time engine; JS backtracks. A line
  // full of a rule's keyword is the worst case for the rules that can repeat.
  const repeating = GITLEAKS_RULES.filter((r) => /[*+]|\{\d+,\}/.test(r.regex[0].replace(/\\[*+]/g, '')));
  it('stays linear on a line holding thousands of keys', () => {
    const key = ['glpat', 'Ab3Cd4Ef5Gh6Ij7Kl8Mn'].join('-');
    const start = performance.now();
    redactSecrets(`${key} `.repeat(32_000));
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('stays linear when an allowlist checks a long value', () => {
    const start = performance.now();
    redactSecrets(`curl -u "user:${'<abc123'.repeat(16_000)}"`);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it.each(['\r', '\n', '\r\n', ' \r'])('stays linear on a curl command followed by many %j', (end) => {
    const start = performance.now();
    redactSecrets(`curl ${end.repeat(2000)} -H`);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it.each([...new Set(repeating.flatMap((r) => r.keywords))])('stays linear on a long line full of %j', (k) => {
    for (const unit of [`${k} `, `${k}=`, `curl -H ${k}`]) {
      const line = unit.repeat(Math.ceil(200_000 / unit.length));
      const start = performance.now();
      redactSecrets(line);
      expect(performance.now() - start).toBeLessThan(1000);
    }
  });
});
