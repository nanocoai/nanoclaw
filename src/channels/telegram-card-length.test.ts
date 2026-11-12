/**
 * Telegram card limit against the real @chat-adapter/telegram: only fetch is
 * stubbed, so the test sees the exact MarkdownV2 text the adapter sends, which
 * Telegram cuts past 4,096.
 */
import { Actions, Button, Card, CardText } from 'chat';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({
  readEnvFile: (keys: string[]) =>
    keys.includes('TELEGRAM_BOT_TOKEN') ? { TELEGRAM_BOT_TOKEN: '100:test-token' } : {},
}));

import { gatewayApprovalPresentation } from '../gateway-approval-presentation.js';
import type { GatewayApprovalRequest } from '../gateway-providers/gateway-provider-registry.js';
import { CardTooLongError } from './ask-question.js';
import { registerQuestionRenderResolver } from './question-render-registry.js';
import { createTelegramBridge, refuseCutCards } from './telegram.js';

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

/** An email approval with 80 Cc and 80 Bcc addresses; Telegram turns each address into a link. */
function emailGatewayCard() {
  const addresses = Array.from({ length: 80 }, () => 'a@b.co').join(' ');
  const summary = {
    agent: 'agent',
    action: 'Send an email',
    resource: 'POST mail.example.com/send',
    reason: 'The gateway policy requires human approval for this request.',
    details: [
      { label: 'Cc', value: addresses },
      { label: 'Bcc', value: addresses },
      { label: 'To', value: 'ceo@example.com' },
    ],
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

  it('keeps a plain gateway title inert after Telegram MarkdownV2 conversion', async () => {
    const card = gatewayApprovalPresentation({
      title: '[Admin](https://evil.test)',
      question: 'Allow?',
    } as GatewayApprovalRequest);
    await ask(card.title, card.question);
    expect(sends()[0].text).toContain('\\[Admin\\]\\(');
    expect(sends()[0].text).not.toContain('[Admin](https://evil.test)');
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

  // An empty list item is 3 characters as typed and about 7 as MarkdownV2.
  it('refuses a card under the limit whose list grows past 4,096 as sent', async () => {
    const question = '\n\n' + '1.\n'.repeat(650) + 'DELETE production';
    expect('Approve'.length + question.length).toBeLessThan(2000);
    await expect(ask('Approve', question)).rejects.toBeInstanceOf(CardTooLongError);
    expect(sends()).toHaveLength(0);
  });

  // An email address is sent as a link, four times as long.
  it('sends a card of exactly 4,096 characters as sent whole, and refuses one more', async () => {
    const addresses = 'a@b.co '.repeat(160);
    await ask('Approve', addresses + 'x'.repeat(86));
    const [message, ...rest] = sends();
    expect(rest).toHaveLength(0);
    expect(message.text).toHaveLength(4096);
    expect(message.text!.endsWith('x'.repeat(86))).toBe(true);
    expect(message.reply_markup?.inline_keyboard.flat()).toHaveLength(2);

    calls.length = 0;
    await expect(ask('Approve', addresses + 'x'.repeat(87))).rejects.toBeInstanceOf(CardTooLongError);
    expect(sends()).toHaveLength(0);
  });

  it('refuses a gateway card under the limit whose email addresses grow past 4,096 as sent', async () => {
    const { title, question } = emailGatewayCard();
    expect(title.length + question.length).toBeLessThan(2000);
    await expect(ask(title, question)).rejects.toBeInstanceOf(CardTooLongError);
    expect(sends()).toHaveLength(0);
  });

  // The adapter swaps an emoji name for its character after converting, which shortens the text.
  it('sends a card whole that fits once the adapter swaps its emoji names', async () => {
    const hearts = '{{emoji:heart}}'.repeat(30);
    await ask('Approve', 'a@b.co '.repeat(150) + '\n```\n' + hearts + '\n```');
    const [message, ...rest] = sends();
    expect(rest).toHaveLength(0);
    expect(message.text!.length).toBeLessThanOrEqual(4096);
    expect(message.text!.endsWith('```')).toBe(true);
    expect(message.reply_markup?.inline_keyboard.flat()).toHaveLength(2);
  });

  it('leaves a card without answer buttons alone', async () => {
    const actions = [{ label: 'Open', url: 'https://example.com' }];
    const card = { title: 'Report', description: 'a@b.co '.repeat(200), actions };
    await bridge.deliver('telegram:42', null, { kind: 'chat-sdk', content: { type: 'card', card } });
    expect(sends()).toHaveLength(1);
  });

  // Custom presentations must also show the whole request before exposing buttons.
  it.each([false, true])('refuses a custom-rendered card whose request would be cut (nested=%s)', async (nested) => {
    const buttons = Actions([Button({ id: 'ncq:custom-1:0', label: 'Approve', value: '0' })]);
    const children = [CardText('a@b.co '.repeat(200)), buttons];
    const card = Card({ title: 'Review', children: nested ? [{ type: 'section', children }] : children });
    registerQuestionRenderResolver((id) =>
      id === 'custom-1' ? { title: 'Review', options: [], renderMessage: () => ({ card }) } : undefined,
    );
    const content = { type: 'ask_question', questionId: 'custom-1', title: 'Review', options: [] };
    await expect(
      bridge.deliver('telegram:42', null, { kind: 'chat-sdk', content: { ...content, requirePresentation: true } }),
    ).rejects.toBeInstanceOf(CardTooLongError);
    expect(sends()).toHaveLength(0);
  });

  it.each([
    ['Approve', 'a@b.co '.repeat(160) + 'x'.repeat(86)],
    ['*Approve', 'q'.repeat(4100) + '*'],
    ['Approve', '.'.repeat(2200)],
  ])('keeps a host-resolved decision when Telegram would cut the request (%s)', async (title, question) => {
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: '42:123',
        terminalCard: { title, question, resolution: 'Approved by Ann' },
      },
    });
    const edits = calls.filter((call) => call.method === 'editMessageText');
    expect(edits).toHaveLength(1);
    expect(edits[0].body.text).toContain('Approved by Ann');
    expect(edits[0].body.text!.length).toBeLessThanOrEqual(4096);
    expect(edits[0].body.reply_markup?.inline_keyboard.flat()).toEqual([]);
  });

  it('keeps the full request on a resolved card that fits', async () => {
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: '42:123',
        terminalCard: { title: 'Review', question: 'Keep this request', resolution: 'Rejected by Ann' },
      },
    });
    const edits = calls.filter((call) => call.method === 'editMessageText');
    expect(edits).toHaveLength(1);
    expect(edits[0].body.text).toContain('Keep this request');
    expect(edits[0].body.text).toContain('Rejected by Ann');
  });

  it('refuses a decision that cannot fit even without the request rather than silently cutting it', async () => {
    await expect(
      bridge.deliver('telegram:42', null, {
        kind: 'chat-sdk',
        content: {
          operation: 'edit',
          messageId: '42:123',
          terminalCard: { title: 'Review', question: 'Request', resolution: 'Approved by ' + 'a'.repeat(4100) },
        },
      }),
    ).rejects.toBeInstanceOf(CardTooLongError);
    expect(calls.filter((call) => call.method === 'editMessageText')).toHaveLength(0);
  });

  it.each([
    Card({ title: 'Custom', subtitle: 'x'.repeat(4200), children: [CardText('Done', { style: 'muted' })] }),
    Card({
      title: 'Custom',
      subtitle: 'Details',
      children: [CardText('x'.repeat(4200)), CardText('Done', { style: 'muted' })],
    }),
    Card({
      title: 'Custom',
      imageUrl: 'https://example.com/image.png',
      children: [CardText('x'.repeat(4200)), CardText('Done', { style: 'muted' })],
    }),
    Card({
      title: 'Custom',
      children: [CardText('x'.repeat(4200), { style: 'bold' }), CardText('Done', { style: 'muted' })],
    }),
  ])('refuses oversized custom resolved-card layouts before truncation', async (card) => {
    const adapter = createTelegramAdapter({ botToken: '100:test-token' });
    const edit = vi.spyOn(adapter, 'editMessage').mockResolvedValue({
      id: '123',
      threadId: 'telegram:42',
      raw: { message_id: 123, chat: { id: 42, type: 'private' }, date: 0 },
    });
    refuseCutCards(adapter);
    const message = { card };
    await expect(adapter.editMessage('telegram:42', '123', message)).rejects.toBeInstanceOf(CardTooLongError);
    expect(edit).not.toHaveBeenCalled();
  });

  it('changes nothing on a core without CardTooLongError', async () => {
    vi.resetModules();
    vi.doMock('./ask-question.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./ask-question.js')>()),
      CardTooLongError: undefined,
    }));
    const { refuseCutCards } = await import('./telegram.js');
    const postMessage = vi.fn();
    const adapter = { postMessage };
    refuseCutCards(adapter as never);
    expect(adapter.postMessage).toBe(postMessage);
    vi.doUnmock('./ask-question.js');
  });
});
