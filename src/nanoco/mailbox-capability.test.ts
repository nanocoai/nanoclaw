import { describe, expect, it } from 'vitest';

import { requestCapabilityFromContext, validateRequestCapability } from './mailbox-capability.js';

const CAPABILITY = '0123456789abcdef'.repeat(4);

describe('mailbox session capability', () => {
  it('accepts only the exact opaque 256-bit lowercase value', () => {
    expect(validateRequestCapability(CAPABILITY)).toBe(CAPABILITY);
    for (const value of [undefined, null, '', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) {
      expect(() => validateRequestCapability(value)).toThrow('request capability');
    }
  });

  it('keeps the SQLite context capability-free and extracts the S3 context', () => {
    expect(requestCapabilityFromContext(null)).toBeUndefined();
    expect(requestCapabilityFromContext({ capability: CAPABILITY })).toBe(CAPABILITY);
    expect(() => requestCapabilityFromContext({ capability: 'wrong' })).toThrow('request capability');
  });
});
