import { describe, expect, it } from 'vitest';

import { voiceEndpoint } from '../../.claude/skills/add-voice/ui/src/lib/voice-endpoint.js';

describe('voice browser URLs (maintainer sources)', () => {
  it.each(['call', 'call/', 'call///'])('resolves sibling routes from %s', (page) => {
    for (const route of ['info', 'sdp', 'hangup'] as const) {
      const url = voiceEndpoint(
        route,
        'token +&',
        `https://example.test/prefix/webhook/voice/${page}?t=old&demo=1#debug`,
      );
      expect(url.pathname).toBe(`/prefix/webhook/voice/${route}`);
      expect(url.searchParams.get('t')).toBe('token +&');
      expect([...url.searchParams.keys()]).toEqual(['t']);
      expect(url.hash).toBe('');
    }
  });
});
