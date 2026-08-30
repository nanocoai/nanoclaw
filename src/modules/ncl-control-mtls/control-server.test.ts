import { describe, expect, test } from 'vitest';

import { isRequestFrame } from './control-server.js';

describe('NCL mTLS control frame boundary', () => {
  test('accepts only the transport-neutral NCL request frame', () => {
    expect(isRequestFrame({ id: 'one', command: 'templates-list', args: {} })).toBe(true);
    expect(isRequestFrame({ id: 'one', command: 'templates-list', args: [], caller: 'host' })).toBe(false);
    expect(isRequestFrame({ id: '', command: 'templates-list', args: {} })).toBe(false);
    expect(isRequestFrame({ id: 'one', command: '', args: {} })).toBe(false);
  });
});
