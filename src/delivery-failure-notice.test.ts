import { describe, expect, it } from 'vitest';

import { MissingChannelAdapterError } from './channels/channel-registry.js';
import { DeliveryTargetError } from './delivery-error.js';
import {
  classifyDeliveryFailure,
  deliveryFailureText,
  shouldNoticeDeliveryFailure,
} from './delivery-failure-notice.js';

describe('deliveryFailureText', () => {
  it('names the files, the text and the reason category, and points to the log', () => {
    const text = deliveryFailureText(
      {
        id: 'out-1',
        channelType: 'slack',
        content: JSON.stringify({ text: 'here is the icon', files: ['desk-avatar.svg'] }),
      },
      'rejected',
    );
    expect(text).toContain('to slack');
    expect(text).toContain('file desk-avatar.svg with text "here is the icon"');
    expect(text).toContain('Reason: the platform rejected it');
    expect(text).toContain('host log has the details (message out-1)');
    expect(text).toContain('NOT delivered');
    expect(text).toContain('do not resend there');
  });

  it('truncates long text', () => {
    const text = deliveryFailureText(
      { id: 'out-1', channelType: 'telegram', content: JSON.stringify({ text: 'x'.repeat(500) }) },
      'other',
    );
    expect(text).toContain(`"${'x'.repeat(120)}…"`);
    expect(text).not.toContain('x'.repeat(121));
  });

  it('describes operations and unparseable content', () => {
    expect(
      deliveryFailureText(
        { id: 'out-1', channelType: 'slack', content: JSON.stringify({ operation: 'reaction' }) },
        'rejected',
      ),
    ).toContain('(reaction operation)');
    expect(deliveryFailureText({ id: 'out-1', channelType: null, content: 'not json' }, 'other')).toContain(
      'your message (a message)',
    );
  });
});

describe('classifyDeliveryFailure', () => {
  it('maps host-side and adapter errors to fixed categories', () => {
    const tg = { channelType: 'telegram' };
    expect(classifyDeliveryFailure(tg, new DeliveryTargetError('not_connected', 'detached'))).toBe('not_connected');
    expect(classifyDeliveryFailure(tg, new DeliveryTargetError('not_authorised', 'no destination'))).toBe(
      'not_authorised',
    );
    expect(classifyDeliveryFailure(tg, new MissingChannelAdapterError('telegram'))).toBe('not_connected');
    expect(classifyDeliveryFailure(tg, new Error('Bad Request: chat not found'))).toBe('rejected');
    expect(classifyDeliveryFailure({ channelType: 'agent' }, new Error('no route'))).toBe('other');
    expect(classifyDeliveryFailure(tg, 'thrown string')).toBe('other');
  });
});

describe('shouldNoticeDeliveryFailure', () => {
  it('skips host-handled rows', () => {
    expect(shouldNoticeDeliveryFailure({ kind: 'chat', inReplyTo: null })).toBe(true);
    expect(shouldNoticeDeliveryFailure({ kind: 'system', inReplyTo: null })).toBe(false);
    expect(shouldNoticeDeliveryFailure({ kind: 'task_log', inReplyTo: null })).toBe(false);
  });

  it('skips a message that answers a delivery-failure note', () => {
    expect(shouldNoticeDeliveryFailure({ kind: 'chat', inReplyTo: 'delivery-failed-out-1' })).toBe(false);
    expect(shouldNoticeDeliveryFailure({ kind: 'chat', inReplyTo: 'msg-7' })).toBe(true);
  });
});
