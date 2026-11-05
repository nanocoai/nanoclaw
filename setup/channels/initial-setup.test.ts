import { describe, expect, it } from 'vitest';

import { otherChannelDiagnostic } from './initial-setup.js';

describe('otherChannelDiagnostic', () => {
  it('keeps public channel names, shipped or not', () => {
    expect(otherChannelDiagnostic('matrix')).toBe('matrix');
    expect(otherChannelDiagnostic('zulip')).toBe('zulip');
  });

  it('sends unknown for anything else the operator typed', () => {
    for (const typed of ['acme-internal', 'my company chat', '/Users/someone/bot', 'Matrix', '']) {
      expect(otherChannelDiagnostic(typed)).toBe('unknown');
    }
  });
});
