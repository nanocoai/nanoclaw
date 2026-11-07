/**
 * Telegram card limit against the real @chat-adapter/telegram: only fetch is
 * stubbed, so the test sees the exact MarkdownV2 text the adapter sends, which
 * Telegram cuts past 4,096.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({
  readEnvFile: (keys: string[]) =>
    keys.includes('TELEGRAM_BOT_TOKEN') ? { TELEGRAM_BOT_TOKEN: '100:test-token' } : {},
}));

import { gatewayApprovalPresentation } from '../gateway-approval-presentation.js';
import type { GatewayApprovalRequest } from '../gateway-providers/gateway-provider-registry.js';
import { CardTooLongError } from './ask-question.js';
import { createTelegramBridge } from './telegram.js';

const calls: Array<{ method: string; body: { text?: string; reply_markup?: { inline_keyboard: unknown[][] } } }> = [];

vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string, init?: { body: string }) => {
    calls.push({ method: url.slice(url.lastIndexOf('/') + 1), body: init?.body ? JSON.parse(init.body) : {} });
    const result = { message_id: calls.length, chat: { id: 42, type: 'private' }, date: 0, text: '' };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }),
);

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  calls.length = 0;
});

/** The review case: a 572-character resource and six 600-character details. */
function longGatewayCard() {
  const summary = {
    agent: 'agent',
    action: 'Post a comment',
    resource: 'POST api.example.com/' + 'r'.repeat(551),
    reason: 'The gateway policy requires human approval for this request.',
    details: Array.from({ length: 6 }, (_, i) => ({ label: `Field ${i}`, value: `D${i}${'v'.repeat(596)}E${i}` })),
  };
  return gatewayApprovalPresentation({ title: 'Credentials Request', question: '', summary } as GatewayApprovalRequest);
}

describe('Telegram card limit through the bridge', () => {
  const bridge = createTelegramBridge()!;
  const sends = () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body);
  const ask = (title: string, question: string) =>
    bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'appr-long-1',
        title,
        question,
        options: [{ label: 'Approve', style: 'primary' }, { label: 'Reject' }],
      },
    });

  // MarkdownV2 escapes every dot, doubling the text.
  it('sends a card at the limit whole, even when escaping doubles its text', async () => {
    await ask('Approve', '.'.repeat(1993));
    const [message, ...rest] = sends();
    expect(rest).toHaveLength(0);
    expect(message.text!.length).toBeLessThanOrEqual(4096);
    expect(message.text!.match(/\\\./g)).toHaveLength(1993);
    expect(message.reply_markup?.inline_keyboard.flat()).toHaveLength(2);
  });

  it('refuses a card one character longer and sends nothing', async () => {
    await expect(ask('Approve', '.'.repeat(1994))).rejects.toBeInstanceOf(CardTooLongError);
    expect(sends()).toHaveLength(0);
  });

  it('refuses a long gateway card instead of cutting it', async () => {
    const { title, question } = longGatewayCard();
    await expect(ask(title, question)).rejects.toBeInstanceOf(CardTooLongError);
    expect(sends()).toHaveLength(0);
  });
});
