import { afterEach, describe, expect, it } from 'vitest';

import { clearSensitiveValuesForTest, createSensitiveRedactor, registerSensitiveValue } from './redaction.js';

afterEach(clearSensitiveValuesForTest);

describe('streaming sensitive-value redaction', () => {
  it('redacts a secret split across child-output chunks', () => {
    registerSensitiveValue('secret-value');
    const redactor = createSensitiveRedactor();
    const output = redactor.write('before secret-') + redactor.write('value after') + redactor.end();
    expect(output).toBe('before [REDACTED] after');
  });

  it('streams safe output while retaining only a possible secret boundary', () => {
    registerSensitiveValue('secret-value');
    const redactor = createSensitiveRedactor();
    const output = redactor.write('visible output '.repeat(100));
    expect(output.length).toBeGreaterThan(1_000);
    expect(output).not.toContain('secret-value');
  });

  it('prefers a longer secret when registered values overlap', () => {
    registerSensitiveValue('secret');
    registerSensitiveValue('secret-value');
    const redactor = createSensitiveRedactor();
    const output = redactor.write('before secret-value after') + redactor.end();
    expect(output).toBe('before [REDACTED] after');
  });
});
