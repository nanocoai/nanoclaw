import { describe, expect, it } from 'vitest';

import { normalizeOption, normalizeOptions } from './ask-question.js';

describe('normalizeOption — style whitelist', () => {
  // The style value flows straight into the Chat SDK Button() and from there
  // into Slack Block Kit. Slack rejects the *entire* message with
  // invalid_blocks if a button carries an unknown style, which in the
  // approval flow means the card never renders — an effective auto-deny.
  // So anything outside the whitelist must drop to undefined here.

  it.each(['primary', 'danger', 'default'] as const)('passes through the known style %j', (style) => {
    expect(normalizeOption({ label: 'Approve', style }).style).toBe(style);
  });

  it('drops unknown style strings to undefined', () => {
    for (const bad of ['success', 'warning', 'PRIMARY', 'Danger', ' primary', 'primary ', '', 'red']) {
      const opt = normalizeOption({ label: 'Approve', style: bad as never });
      expect(opt.style, `style ${JSON.stringify(bad)} should be dropped`).toBeUndefined();
    }
  });

  it('drops non-string style values to undefined', () => {
    for (const bad of [1, true, null, {}, ['primary']]) {
      const opt = normalizeOption({ label: 'Approve', style: bad as never });
      expect(opt.style, `style ${JSON.stringify(bad)} should be dropped`).toBeUndefined();
    }
  });

  it('leaves style undefined when the object option omits it', () => {
    expect(normalizeOption({ label: 'Approve' }).style).toBeUndefined();
  });

  it('gives string-shorthand options no style', () => {
    const opt = normalizeOption('Approve');
    expect(opt).toEqual({ label: 'Approve', selectedLabel: 'Approve', value: 'Approve' });
    expect('style' in opt && opt.style !== undefined).toBe(false);
  });

  it('style coexists with the label/selectedLabel/value defaulting', () => {
    // Defaults still fill in around an explicit style…
    expect(normalizeOption({ label: 'Approve', style: 'primary' })).toEqual({
      label: 'Approve',
      selectedLabel: 'Approve',
      value: 'Approve',
      style: 'primary',
    });
    // …and explicit fields are untouched by the style whitelist.
    expect(normalizeOption({ label: 'Deny', selectedLabel: 'Denied', value: 'deny-1', style: 'danger' })).toEqual({
      label: 'Deny',
      selectedLabel: 'Denied',
      value: 'deny-1',
      style: 'danger',
    });
    // An invalid style must not disturb the rest of the normalization.
    expect(normalizeOption({ label: 'Deny', value: 'deny-1', style: 'bogus' as never })).toEqual({
      label: 'Deny',
      selectedLabel: 'Deny',
      value: 'deny-1',
      style: undefined,
    });
  });
});

describe('normalizeOptions', () => {
  it('normalizes mixed string and object options, preserving order and per-option styles', () => {
    const out = normalizeOptions([
      'Skip',
      { label: 'Approve', style: 'primary' },
      { label: 'Deny', style: 'danger' },
      { label: 'Later', style: 'lime' as never },
    ]);
    expect(out.map((o) => o.label)).toEqual(['Skip', 'Approve', 'Deny', 'Later']);
    expect(out.map((o) => o.style)).toEqual([undefined, 'primary', 'danger', undefined]);
  });
});
