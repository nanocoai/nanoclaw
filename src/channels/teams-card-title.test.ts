import { cardToAdaptiveCard } from '@chat-adapter/teams';
import type { Adapter, AdapterPostableMessage, CardElement } from 'chat';
import { expect, it, vi } from 'vitest';
import { createChatSdkBridge } from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));

it('keeps an approval title literal in Teams Adaptive Card text on post and edit', async () => {
  const cards: CardElement[] = [];
  const capture = async (_id: string, message: AdapterPostableMessage) => {
    cards.push((message as { card: CardElement }).card);
    return { id: 'm', threadId: 't', raw: {} };
  };
  const adapter = {
    name: 'teams',
    postMessage: capture,
    editMessage: async (id: string, _messageId: string, message: AdapterPostableMessage) => capture(id, message),
  } as unknown as Adapter;
  const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
  const title = '[Admin](https://evil.test)';
  await bridge.deliver('t', null, {
    kind: 'chat-sdk',
    content: {
      type: 'ask_question',
      questionId: 'q',
      title,
      question: 'Allow?',
      options: ['Approve'],
    },
  });
  await bridge.deliver('t', null, {
    kind: 'chat-sdk',
    content: {
      operation: 'edit',
      messageId: 'm',
      terminalCard: { title, question: 'Allow?', resolution: 'Approved' },
    },
  });
  expect(cards).toHaveLength(2);
  for (const card of cards) {
    const wire = JSON.stringify(cardToAdaptiveCard(card));
    expect(wire).toContain(JSON.stringify('\\[Admin\\]\\(https://evil.test\\)').slice(1, -1));
    expect(wire).not.toContain(title);
  }
});
