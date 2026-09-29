import { describe, expect, it } from 'vitest';

import { redactLogData } from './log.js';

describe('operator log redaction', () => {
  it('redacts nested credentials and omits large payload fields', () => {
    const value = redactLogData({
      componentSecret: 'component-secret',
      nested: {
        accessToken: 'access-token',
        authorization: 'Bearer bearer-token',
        safeId: 'task-123',
      },
      arguments: { city: 'Riga', password: 'inside-payload' },
      payload: { result: 'private-result' },
    });

    expect(value).toEqual({
      componentSecret: '[REDACTED]',
      nested: {
        accessToken: '[REDACTED]',
        authorization: '[REDACTED]',
        safeId: 'task-123',
      },
      arguments: '[OMITTED]',
      payload: '[OMITTED]',
    });
  });

  it('redacts credentials embedded in error messages and stacks', () => {
    const error = new Error('request failed: authorization=BearerToken password=hunter2');
    const value = redactLogData({ err: error }) as {
      err: { message: string; stack?: string };
    };

    expect(value.err.message).not.toContain('BearerToken');
    expect(value.err.message).not.toContain('hunter2');
    expect(value.err.stack).not.toContain('BearerToken');
    expect(value.err.stack).not.toContain('hunter2');
  });
});
