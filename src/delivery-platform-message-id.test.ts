/**
 * Inbound rows carry a `:<agent group id>` suffix; reactions (and edits) must
 * reach the platform with the bare platform message id.
 */
import { describe, expect, it } from 'vitest';

import { withPlatformMessageId } from './delivery.js';

const ag = 'ag-1700000000000-abc123';

function run(content: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(withPlatformMessageId(content, JSON.stringify(content), ag));
}

describe('withPlatformMessageId', () => {
  it('strips the agent-group suffix from a reaction target', () => {
    expect(run({ operation: 'reaction', messageId: `-1001234567890:449:${ag}`, emoji: 'thumbs_up' })).toEqual({
      operation: 'reaction',
      messageId: '-1001234567890:449',
      emoji: 'thumbs_up',
    });
  });

  it('leaves ids without the suffix alone', () => {
    const content = { operation: 'reaction', messageId: '-1001234567890:449', emoji: 'heart' };
    expect(run(content)).toEqual(content);
  });

  it('leaves plain chat messages byte-identical', () => {
    const raw = JSON.stringify({ text: `hi :${ag}` });
    expect(withPlatformMessageId(JSON.parse(raw), raw, ag)).toBe(raw);
  });
});
