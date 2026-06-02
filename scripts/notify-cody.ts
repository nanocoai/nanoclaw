/**
 * Send an operator-routed message to the Cody Telegram DM.
 *
 * Usage:
 *   pnpm exec tsx scripts/notify-cody.ts "message text"
 */
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../src/config.js';

const text = process.argv.slice(2).join(' ').trim();

if (!text) {
  console.error('usage: pnpm exec tsx scripts/notify-cody.ts "message text"');
  process.exit(1);
}

const payload = {
  text,
  sender: 'Sawyer',
  senderId: 'telegram_cody:7914645494',
  to: {
    channelType: 'telegram_cody',
    platformId: 'telegram:7914645494',
    threadId: 'telegram:7914645494',
  },
};

const socket = net.connect(path.join(DATA_DIR, 'cli.sock'));

socket.once('error', (err) => {
  console.error(`Cody notification failed: ${err.message}`);
  process.exit(2);
});

socket.once('connect', () => {
  socket.write(JSON.stringify(payload) + '\n', (err) => {
    if (err) {
      console.error(`Cody notification failed: ${err.message}`);
      process.exit(2);
    }
    setTimeout(() => socket.end(), 100);
  });
});

socket.once('close', () => process.exit(0));
