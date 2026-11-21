/**
 * Telegram service messages (e.g. "X hid the general topic") reach the bridge
 * as messages with no text and no attachments. The inbound interceptor drops
 * them so the agent never answers an "empty message". Kill condition: remove
 * the isEmptyInbound guard and "drops" goes red.
 */
import { describe, expect, it, vi } from 'vitest';

import type { InboundMessage } from './adapter.js';
import { createTelegramInboundInterceptor } from './telegram.js';

function message(content: Record<string, unknown>): InboundMessage {
  return { id: 'm1', kind: 'chat-sdk', content, timestamp: new Date().toISOString() };
}

describe('telegram empty inbound', () => {
  const hostOnInbound = vi.fn();
  const onInbound = createTelegramInboundInterceptor(Promise.resolve('Bot'), hostOnInbound, 'tok', 'telegram');

  it('drops a message with no text and no attachments', async () => {
    hostOnInbound.mockClear();
    await onInbound('telegram:123', null, message({ text: '', attachments: [], author: { userId: '1' } }));
    await onInbound('telegram:123', null, message({ text: '  ' }));
    expect(hostOnInbound).not.toHaveBeenCalled();
  });

  it('forwards an attachment-only message (voice, photo)', async () => {
    hostOnInbound.mockClear();
    await onInbound('telegram:123', null, message({ text: '', attachments: [{ type: 'audio' }] }));
    expect(hostOnInbound).toHaveBeenCalledOnce();
  });

  it('forwards text', async () => {
    hostOnInbound.mockClear();
    await onInbound('telegram:123', null, message({ text: 'hi' }));
    expect(hostOnInbound).toHaveBeenCalledOnce();
  });
});
