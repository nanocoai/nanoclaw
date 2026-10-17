/**
 * The chat client's exit code and raw-lines mode are what the setup ping reads.
 * Runs the real script against a fake CLI socket.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CHAT = path.resolve('scripts/chat.ts');
const TSX = path.resolve('node_modules/.bin/tsx');

let dir: string;
let server: net.Server;

beforeEach(() => {
  // Short path: Unix socket paths are capped near 104 bytes on macOS.
  dir = fs.mkdtempSync('/tmp/nc-chat-');
  fs.mkdirSync(path.join(dir, 'data'));
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Serve these socket lines in reply to the first message, then run the client. */
async function chat(lines: object[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string }> {
  server = net.createServer((socket) => {
    socket.once('data', () => {
      for (const line of lines) socket.write(JSON.stringify(line) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(path.join(dir, 'data', 'cli.sock'), resolve));
  return new Promise((resolve) => {
    const child = spawn(TSX, [CHAT, 'ping'], { cwd: dir, env: { ...process.env, ...env } });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

describe('chat client', () => {
  it('exits 0 on a normal reply', async () => {
    const r = await chat([{ text: 'pong' }]);
    expect(r).toEqual({ code: 0, stdout: 'pong\n' });
  }, 20_000);

  it('exits 4 when a reply is a failure notice', async () => {
    const r = await chat([{ text: 'Done part one.' }, { text: 'Spending limit reached', failureNotice: true }]);
    expect(r).toEqual({ code: 4, stdout: 'Done part one.\nSpending limit reached\n' });
  }, 20_000);

  it('echoes socket lines as-is in raw-lines mode', async () => {
    const notice = { text: 'Spending limit reached', failureNotice: true };
    const r = await chat([notice], { NANOCLAW_CHAT_RAW_LINES: '1' });
    expect(r.code).toBe(4);
    expect(JSON.parse(r.stdout)).toEqual(notice);
  }, 20_000);
});
