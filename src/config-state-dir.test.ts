import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { resolveStateRoot } from './config.js';

describe('resolveStateRoot', () => {
  test('preserves the checkout root when no state override is configured', () => {
    expect(resolveStateRoot('/srv/nanoclaw-household', undefined)).toBe('/srv/nanoclaw-household');
  });

  test('resolves an explicit state root independently of the checkout', () => {
    expect(resolveStateRoot('/srv/nanoclaw-household', '/var/lib/nanoclaw-household/state/playbox')).toBe(
      path.resolve('/var/lib/nanoclaw-household/state/playbox'),
    );
  });
});
