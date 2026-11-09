import { createTelegramAdapter } from '@chat-adapter/telegram';
import type { Message } from 'chat';
import { describe, expect, it } from 'vitest';

import { keepCommandsAsMessages } from './telegram.js';

function commandUpdate(text: string, commandLength: number) {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_767_225_600,
      chat: { id: -100123, type: 'group', title: 'Team' },
      from: { id: 42, is_bot: false, first_name: 'Ada' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: commandLength }],
    },
  };
}

function adapterWithSpies(keepCommands: boolean) {
  const adapter = createTelegramAdapter({ botToken: '123:test', mode: 'polling' });
  if (keepCommands) keepCommandsAsMessages(adapter);
  const messages: Message[] = [];
  const commands: unknown[] = [];
  (adapter as unknown as { chat: unknown }).chat = {
    processMessage: async (_adapter: unknown, _threadId: string, message: Message) => {
      messages.push(message);
    },
    processSlashCommand: async (event: unknown) => {
      commands.push(event);
    },
  };
  const process = (update: unknown) =>
    Promise.all((adapter as unknown as { processUpdate: (u: unknown) => Promise<unknown>[] }).processUpdate(update));
  return { process, messages, commands };
}

describe('keepCommandsAsMessages with the installed Telegram adapter', () => {
  it('the adapter alone routes /connect_group away from the message path', async () => {
    const { process, messages, commands } = adapterWithSpies(false);
    await process(commandUpdate('/connect_group', 14));
    expect(messages).toHaveLength(0);
    expect(commands).toHaveLength(1);
  });

  it('delivers /connect_group as a message', async () => {
    const { process, messages, commands } = adapterWithSpies(true);
    await process(commandUpdate('/connect_group', 14));
    expect(commands).toHaveLength(0);
    expect(messages.map((m) => m.text)).toEqual(['/connect_group']);
  });
});
