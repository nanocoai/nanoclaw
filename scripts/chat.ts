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
import fs from 'fs';
import net from 'net';
import path from 'path';

import { CENTRAL_DB_PATH, DATA_DIR } from '../src/config.js';
import { closeDb, initDb } from '../src/db/connection.js';
import { checkCliWiring, WIRE_HINT } from './chat-wiring.js';

// Same field the CLI channel forwards; src/channels/cli.test.ts pins the copies.
const FAILURE_NOTICE_FIELD = 'failureNotice';
// Machine mode for the setup ping: echo each socket line as-is, so the ping
// reads the failure flag and text without parsing display output.
const RAW_LINES = process.env.NANOCLAW_CHAT_RAW_LINES === '1';
const SILENCE_MS = 2000; // exit after this much quiet time following the first reply
// Hard stop before the first reply. The setup ping sets its own: it keeps
// waiting for a slow first reply as long as the user chooses to.
const timeoutOverride = Number(process.env.NANOCLAW_CHAT_TIMEOUT_MS);
const TOTAL_TIMEOUT_MS =
  Number.isInteger(timeoutOverride) && timeoutOverride > 0 && timeoutOverride <= 2 ** 31 - 1
    ? timeoutOverride
    : 120_000;

function socketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}

/**
 * Fail fast when `cli/local` has no agent wired: the message would route and
 * wake a container, but no reply can ever come back to this terminal, so the
 * old behavior was a 120s opaque timeout (#2703). Best-effort — any error in
 * the check itself (missing DB, schema drift) falls through to the normal
 * chat path, which still carries its own timeout.
 */
async function warnIfUnwired(): Promise<boolean> {
  // Opening a missing DB would create it as a side effect; a fresh checkout
  // has no wiring to check anyway, and the socket-connect error path already
  // explains a not-running service better than the wiring hint would.
  if (!fs.existsSync(CENTRAL_DB_PATH)) return false;
  try {
    const db = await initDb(CENTRAL_DB_PATH, { role: 'tool' });
    const status = await checkCliWiring(db);
    await closeDb();
    if (status !== 'wired') {
      console.error(WIRE_HINT);
      return true;
    }
  } catch {
    // Preflight is advisory only — never block chat on it.
  }
  return false;
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

// Usage errors stay first and cost no DB open; the wiring preflight runs
// only when there is actually a message to send.
if (process.argv.length > 2 && (await warnIfUnwired())) {
  process.exit(4);
}
main();
