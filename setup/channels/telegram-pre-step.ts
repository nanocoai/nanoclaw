/**
 * The wizard's Telegram pre-step. It decides one thing: whether to offer
 * "add another bot" (only when .env already holds TELEGRAM_BOT_TOKEN) and what
 * that choice pre-binds for the add-telegram skill's prompts: `add_another`
 * (yes/no), the existing `bot_token` (so the driver's reuse offer never asks
 * again what the operator just answered) and, on yes, `bot_name`. Undefined
 * (no token yet) is the first-bot walkthrough, unchanged. The skill's own
 * fences do the rest (second token, env keys, restart, instance-bound
 * pairing); run-channel-skill forwards its `instance` var to the wire. A
 * cancel exits setup like every other wizard prompt.
 */
import * as p from '@clack/prompts';

import { readEnvFile } from '../../src/env.js';
import { readEnvKey } from '../environment.js';
import { brightSelect } from '../lib/bright-select.js';
import { ensureAnswer } from '../lib/runner.js';
import type { ChannelPreStep } from './companions.js';

/** The adapter's TELEGRAM_INSTANCES name rule (see the telegram-multi-instance skill). */
const BOT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

async function addAnotherTelegramBot(): Promise<Record<string, string> | undefined> {
  // The host's own .env reader, so the pre-bound token is exactly what the
  // adapter loads (hand-quoted values unwrapped). Pre-bound inputs win outright
  // at bind: a still-quoted token would fail the prompt's validate and dead-end
  // the run on both paths.
  const token = readEnvFile(['TELEGRAM_BOT_TOKEN']).TELEGRAM_BOT_TOKEN;
  if (!token) return undefined;
  const choice = ensureAnswer(
    await brightSelect<'keep' | 'add'>({
      message: 'A Telegram bot is already configured. Use it, or add another?',
      options: [
        { value: 'keep', label: 'Use the existing bot', hint: 'TELEGRAM_BOT_TOKEN stays as it is' },
        { value: 'add', label: 'Add another bot', hint: 'a second token, paired and wired on its own' },
      ],
    }),
  );
  if (choice === 'keep') return { add_another: 'no', bot_token: token };
  const botName = ensureAnswer(
    await p.text({
      message: 'Short name for the new bot (lowercase letters, digits, dashes; e.g. mega)',
      validate: (v) => {
        const name = (v ?? '').trim();
        if (!BOT_NAME_RE.test(name))
          return 'Use lowercase letters, digits and dashes, starting with a letter or digit.';
        // Same predicate as the skill's effect:check fence: a name whose token
        // key is already set is taken (storing under it would overwrite that bot).
        const key = `TELEGRAM_BOT_TOKEN_${name.toUpperCase().replace(/-/g, '_')}`;
        if (readEnvKey(key))
          return `${name} is taken: ${key} is already set in .env. Pick another name, or pair that bot again with: pnpm exec tsx setup/index.ts --step pair-telegram -- --intent main --instance telegram-${name}`;
      },
    }),
  );
  return { add_another: 'yes', bot_name: botName.trim(), bot_token: token };
}

export function registerTelegramPreStep(register: (channel: string, step: ChannelPreStep) => void): void {
  register('telegram', addAnotherTelegramBot);
}
