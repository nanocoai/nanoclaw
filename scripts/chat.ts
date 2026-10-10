/**
 * Terminal chat with your NanoClaw agent (`pnpm run chat`).
 *
 * Usage:
 *   pnpm run chat <message...>
 *
 * Sends the message through the CLI channel (Unix socket) to the wired agent.
 * Reads replies until the stream goes quiet, then exits.
 *
 * Exit codes: 0 reply, 2 socket unreachable, 3 no reply,
 * 4 a reply was the runner's failure notice (the agent run failed).
 *
 * Preconditions: NanoClaw host service running, an agent group wired to
 * `cli/local` via `/init-first-agent` or `/manage-channels`.
 */
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../src/config.js';

// Same field the CLI channel forwards; src/channels/cli.test.ts pins the copies.
const FAILURE_NOTICE_FIELD = 'failureNotice';
// Machine mode for the setup ping: echo each socket line as-is, so the ping
// reads the failure flag and text without parsing display output.
const RAW_LINES = process.env.NANOCLAW_CHAT_RAW_LINES === '1';
const SILENCE_MS = 2000; // exit after this much quiet time following the first reply
const TOTAL_TIMEOUT_MS = 120_000; // hard stop

function socketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}

function main(): void {
  const words = process.argv.slice(2);
  if (words.length === 0) {
    console.error('usage: pnpm run chat <message...>');
    process.exit(1);
  }
  const text = words.join(' ');

  const socket = net.connect(socketPath());

  socket.on('error', (err) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
      console.error(`NanoClaw daemon not reachable at ${socketPath()}.`);
      console.error('Start the service (launchctl/systemd) before running `pnpm run chat`.');
    } else {
      console.error('CLI socket error:', err);
    }
    process.exit(2);
  });

  let firstReplySeen = false;
  let failureNoticeSeen = false;
  let silenceTimer: NodeJS.Timeout | null = null;
  let hardTimer: NodeJS.Timeout | null = null;

  function scheduleExit(): void {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      socket.end();
      process.exit(failureNoticeSeen ? 4 : 0);
    }, SILENCE_MS);
  }

  socket.on('connect', () => {
    socket.write(JSON.stringify({ text }) + '\n');
    hardTimer = setTimeout(() => {
      if (!firstReplySeen) {
        console.error(`timeout: no reply in ${TOTAL_TIMEOUT_MS}ms`);
        socket.end();
        process.exit(3);
      }
    }, TOTAL_TIMEOUT_MS);
  });

  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.text === 'string') {
          process.stdout.write((RAW_LINES ? line : msg.text) + '\n');
          firstReplySeen = true;
          if (msg[FAILURE_NOTICE_FIELD] === true) failureNoticeSeen = true;
          if (hardTimer) {
            clearTimeout(hardTimer);
            hardTimer = null;
          }
          scheduleExit();
        }
      } catch {
        // Ignore non-JSON lines — forward compatibility.
      }
    }
  });

  socket.on('close', () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (hardTimer) clearTimeout(hardTimer);
    process.exit(!firstReplySeen ? 3 : failureNoticeSeen ? 4 : 0);
  });
}

main();
