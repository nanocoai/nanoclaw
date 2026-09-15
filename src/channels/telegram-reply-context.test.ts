import { describe, expect, it } from 'vitest';

import { extractTelegramReplyContext } from './telegram.js';

describe('Telegram reply context', () => {
  const replyRaw = (from: { is_bot?: boolean; username?: string; first_name?: string }) => ({
    reply_to_message: {
      text: 'Earlier bot answer',
      from,
    },
  });

  it('marks a reply to the current bot using a normalized exact username match', () => {
    expect(
      extractTelegramReplyContext(
        replyRaw({ is_bot: true, username: 'Current_Bot', first_name: 'Current Bot' }),
        '@current_bot',
      ),
    ).toMatchObject({
      text: 'Earlier bot answer',
      sender: 'Current Bot',
      isReplyToBot: true,
    });
  });

  it.each([
    ['another bot', { is_bot: true, username: 'another_bot' }, 'current_bot'],
    ['a human', { is_bot: false, username: 'person' }, 'current_bot'],
    ['an unresolved identity', { is_bot: true, username: 'current_bot' }, null],
  ])('fails closed for a reply to %s', (_label, from, botUsername) => {
    expect(
      (extractTelegramReplyContext(replyRaw(from), botUsername) as { isReplyToBot?: boolean } | null)?.isReplyToBot,
    ).toBe(false);
  });
});
