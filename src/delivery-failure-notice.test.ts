import { describe, expect, it } from 'vitest';

import { deliveryFailureText, shouldNoticeDeliveryFailure } from './delivery-failure-notice.js';

const missingScope = new Error('An API error occurred: missing_scope');

describe('deliveryFailureText', () => {
  it('names the files, the text and the platform error', () => {
    const text = deliveryFailureText(
      { channelType: 'slack', content: JSON.stringify({ text: 'here is the icon', files: ['desk-avatar.svg'] }) },
      missingScope,
    );
    expect(text).toContain('to slack');
    expect(text).toContain('file desk-avatar.svg with text "here is the icon"');
    expect(text).toContain('missing_scope');
    expect(text).toContain('NOT delivered');
  });

  it('truncates long text', () => {
    const text = deliveryFailureText(
      { channelType: 'telegram', content: JSON.stringify({ text: 'x'.repeat(500) }) },
      'boom',
    );
    expect(text).toContain(`"${'x'.repeat(120)}…"`);
    expect(text).not.toContain('x'.repeat(121));
  });

  it('describes operations and unparseable content', () => {
    expect(
      deliveryFailureText({ channelType: 'slack', content: JSON.stringify({ operation: 'reaction' }) }, missingScope),
    ).toContain('(reaction operation)');
    expect(deliveryFailureText({ channelType: null, content: 'not json' }, missingScope)).toContain(
      'your message (a message)',
    );
  });
});

describe('shouldNoticeDeliveryFailure', () => {
  it('skips host-handled rows', () => {
    expect(shouldNoticeDeliveryFailure({ kind: 'chat' })).toBe(true);
    expect(shouldNoticeDeliveryFailure({ kind: 'system' })).toBe(false);
    expect(shouldNoticeDeliveryFailure({ kind: 'task_log' })).toBe(false);
  });
});
