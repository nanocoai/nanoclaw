import { describe, it, expect } from 'vitest';

import { buildTriggerPattern, getTriggerPattern } from './config.js';

describe('buildTriggerPattern', () => {
  const pattern = buildTriggerPattern('@Carson');

  it('matches trigger at start of message', () => {
    expect(pattern.test('@Carson hello')).toBe(true);
  });

  it('matches trigger case-insensitively', () => {
    expect(pattern.test('@carson hello')).toBe(true);
  });

  it('does not match trigger mid-word', () => {
    expect(pattern.test('email@Carson.com')).toBe(false);
  });

  it('matches trigger after media prefix like [Photo]', () => {
    expect(pattern.test('[Photo] @Carson what is this?')).toBe(true);
  });

  it('matches trigger after [Video] prefix', () => {
    expect(pattern.test('[Video] @Carson check this')).toBe(true);
  });

  it('matches trigger after [Audio] prefix', () => {
    expect(pattern.test('[Audio] @Carson listen to this')).toBe(true);
  });

  it('matches trigger after [Document: file.pdf] prefix', () => {
    expect(pattern.test('[Document: report.pdf] @Carson review this')).toBe(
      true,
    );
  });

  it('does not match without trigger word', () => {
    expect(pattern.test('hello world')).toBe(false);
  });

  it('does not match partial trigger', () => {
    expect(pattern.test('@Carsonify something')).toBe(false);
  });
});

describe('getTriggerPattern', () => {
  it('uses custom trigger when provided', () => {
    const pattern = getTriggerPattern('@Bot');
    expect(pattern.test('@Bot hello')).toBe(true);
    expect(pattern.test('@Carson hello')).toBe(false);
  });

  it('handles trigger after media prefix', () => {
    const pattern = getTriggerPattern('@Bot');
    expect(pattern.test('[Photo] @Bot what is this?')).toBe(true);
  });
});
