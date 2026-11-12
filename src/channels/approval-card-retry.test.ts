import { describe, expect, it, vi } from 'vitest';
import type { Adapter } from 'chat';
import { CardTooLongError } from './ask-question.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';

describe('parent approval-card edit recovery', () => {
  it.each([['size refusal', new CardTooLongError('too long'), false], ['transient error', new Error('HTTP 500'), true]] as const)(
    '%s retries with the right request text', async (_reason, failure, keepsQuestion) => {
      const editMessage = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ id: 'card' });
      const bridge = createChatSdkBridge({ adapter: { name: 'fixture', editMessage } as unknown as Adapter, supportsThreads: false });
      await bridge.deliver('fixture:room', null, { kind: 'chat-sdk', content: {
        operation: 'edit', messageId: 'card', terminalCard: { title: 'Review', question: 'Allow this request?', resolution: 'Approved by Ann' },
      } });
      expect(editMessage).toHaveBeenCalledTimes(2);
      const rendered = JSON.stringify(editMessage.mock.calls[1][2]);
      expect(rendered.includes('Allow this request?')).toBe(keepsQuestion);
      expect(rendered).toContain('Approved by Ann');
      if (keepsQuestion) expect(editMessage.mock.calls[1]).toEqual(editMessage.mock.calls[0]);
    },
  );
  it('propagates a failed retry rather than reporting successful delivery', async () => {
    const editMessage = vi.fn().mockRejectedValue(new Error('offline'));
    const bridge = createChatSdkBridge({ adapter: { name: 'fixture', editMessage } as unknown as Adapter, supportsThreads: false });
    await expect(bridge.deliver('fixture:room', null, { kind: 'chat-sdk', content: {
      operation: 'edit', messageId: 'card', terminalCard: { title: 'Review', question: 'Allow?', resolution: 'Denied' },
    } })).rejects.toThrow('offline');
    expect(editMessage).toHaveBeenCalledTimes(2);
  });
});
