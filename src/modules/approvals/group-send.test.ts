/**
 * Regression test for the group-autopost guard: an outbound message bound
 * for a group chat (is_group=1) must ALWAYS be held for per-message
 * operator approval — replies to @-mentions included — while DMs and
 * agent-to-agent traffic pass through.
 */
import { describe, it, expect } from 'vitest';

import { shouldGateGroupSend } from './group-send.js';

describe('shouldGateGroupSend', () => {
  it('gates any send to a group chat, including reply-shaped ones', () => {
    expect(shouldGateGroupSend(1, 'whatsapp')).toBe(true);
    expect(shouldGateGroupSend(1, 'telegram')).toBe(true);
  });

  it('does not gate DMs', () => {
    expect(shouldGateGroupSend(0, 'whatsapp')).toBe(false);
    expect(shouldGateGroupSend(0, 'telegram')).toBe(false);
  });

  it('does not gate agent-to-agent or unrouted messages', () => {
    expect(shouldGateGroupSend(1, 'agent')).toBe(false);
    expect(shouldGateGroupSend(1, null)).toBe(false);
  });
});
