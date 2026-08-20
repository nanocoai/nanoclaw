/**
 * migrate-v2: interactive channel selection via clack multiselect.
 *
 * Writes selected channel names (one per line) to the file path given as
 * the first argument. Clack renders to the terminal normally.
 *
 * If NANOCLAW_CHANNELS env var is set (comma-separated names), skips the
 * prompt and writes those directly.
 *
 * Usage: pnpm exec tsx setup/migrate-v2/select-channels.ts <output-file>
 */
import fs from 'fs';

import * as p from '@clack/prompts';
import { styleText } from 'node:util';

const CHANNELS = [
  { value: 'telegram', label: 'Telegram' },
  { value: 'discord', label: 'Discord' },
  { value: 'slack', label: 'Slack' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'teams', label: 'Microsoft Teams' },
  { value: 'matrix', label: 'Matrix' },
  { value: 'imessage', label: 'iMessage' },
  { value: 'webex', label: 'Webex' },
  { value: 'gchat', label: 'Google Chat' },
  { value: 'resend', label: 'Resend (email)' },
  { value: 'github', label: 'GitHub' },
  { value: 'linear', label: 'Linear' },
  { value: 'whatsapp-cloud', label: 'WhatsApp Cloud API' },
];

const VALID_NAMES = new Set(CHANNELS.map((c) => c.value));

async function main(): Promise<void> {
  const outFile = process.argv[2];
  if (!outFile) {
    console.error('Usage: tsx setup/migrate-v2/select-channels.ts <output-file>');
    process.exit(1);
  }

  // Non-interactive: NANOCLAW_CHANNELS="telegram,discord"
  const envChannels = process.env.NANOCLAW_CHANNELS?.trim();
  if (envChannels) {
    const names = envChannels
      .split(',')
      .map((s) => s.trim())
      .filter((s) => VALID_NAMES.has(s));
    fs.writeFileSync(outFile, names.join('\n') + '\n');
    return;
  }

  const selected = await p.multiselect({
    message: 'Which channels do you want to set up?\n' + styleText('dim', '  space to select, enter to confirm') + '\n',
    options: CHANNELS,
    required: false,
  });

  if (p.isCancel(selected)) {
    fs.writeFileSync(outFile, '');
    return;
  }

  fs.writeFileSync(outFile, (selected as string[]).join('\n') + '\n');
}

main();
