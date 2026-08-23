/**
 * Regression: adapter 4.28.1..4.31.0 cut a MarkdownV2 link URL with an odd count of
 * _ * ~ (the OneCLI connect link) and Telegram rejected it. Bot API stubbed at fetch.
 */
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { ConsoleLogger } from 'chat';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const CONNECT_URL =
  'http://127.0.0.1:10254/connections?connect=google-calendar&source=agent&agent_name=family%2Dassistant';

const sends: unknown[] = [];

function reply(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status });
}

beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const method = String(input).split('/').pop() ?? '';
      // The real API answers 404 for methods it does not implement (sendRichMessage is Bot API 10.1).
      if (method.startsWith('sendRichMessage')) {
        return reply(404, { ok: false, error_code: 404, description: 'Not Found: method not found' });
      }
      if (method === 'sendMessage') sends.push(JSON.parse(String(init?.body)));
      return reply(200, {
        ok: true,
        result: { message_id: 1, date: 1, chat: { id: 12345, type: 'private' }, text: 'ok' },
      });
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('telegram outbound MarkdownV2 links', () => {
  it.each([
    ['markdown link', `Connect here: [Google Calendar](${CONNECT_URL})`],
    ['bare URL on its own line', `Connect here:\n${CONNECT_URL}`],
  ])('delivers the OneCLI connect link intact (%s)', async (_label, markdown) => {
    sends.length = 0;
    const adapter = createTelegramAdapter({
      botToken: 'stub:token',
      mode: 'webhook',
      logger: new ConsoleLogger('silent'),
    });
    await adapter.postMessage('12345', { markdown });

    // One sendMessage whose text still carries the odd-underscore query and the tail of the URL.
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ text: expect.stringContaining('agent_name=family%2Dassistant') });
  });
});
