/**
 * CLI admin transport: a routed line's `to.instance` reaches the router as
 * InboundEvent.instance.
 *
 * What breaks without it: init-first-agent's welcome for a named adapter
 * instance (a second Telegram bot registered as `telegram-mega`) arrives
 * instance-less, the router resolves the DEFAULT instance's row, and the
 * welcome leaves through the wrong bot (or auto-creates an unwired row).
 * Kill condition: delete `instance: to.instance` from the routed InboundEvent
 * in handleLine (or the instance parse in parseAddress) and the first case
 * goes red; drop the `log.warn` on a rejected `to.instance` and the last case
 * goes red.
 *
 * Chat delivery forwards the runner's failureNotice flag so the setup ping
 * can tell a failed run from a real reply. Kill condition: drop the flag from
 * deliver() and the failure-notice case goes red.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { log } from '../log.js';
import type { InboundEvent } from './adapter.js';

// vi.mock factories are hoisted above imports, so the socket dir is a hoisted
// literal: the adapter must never bind a running install's data/cli.sock.
const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/nanoclaw-cli-channel-test-${process.pid}` }));
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

import { FAILURE_NOTICE_FIELD } from './cli.js';
import { getChannelAdapterExact, initChannelAdapters, teardownChannelAdapters } from './channel-registry.js';

let nextEvent: ((event: InboundEvent) => void) | null = null;
let nextChat: (() => void) | null = null;

beforeAll(async () => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initChannelAdapters(() => ({
    onInbound() {
      nextChat?.();
    },
    onInboundEvent(event) {
      nextEvent?.(event);
    },
    onMetadata() {},
    onAction() {},
  }));
});

afterAll(async () => {
  await teardownChannelAdapters();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/** Write one routed (`to`-bearing) line over the socket; resolve with the event the adapter handed the host. */
function routed(to: Record<string, unknown>): Promise<InboundEvent> {
  return new Promise((resolve, reject) => {
    nextEvent = resolve;
    const socket = net.connect(path.join(TEST_DIR, 'cli.sock'), () => {
      socket.end(JSON.stringify({ text: 'hello', to }) + '\n');
    });
    socket.once('error', reject);
  });
}

describe('cli channel: routed message carries to.instance', () => {
  const to = { channelType: 'telegram', platformId: 'telegram:42', threadId: null };

  it('stamps a named instance onto the InboundEvent', async () => {
    const event = await routed({ ...to, instance: 'telegram-mega' });
    expect(event).toMatchObject({ channelType: 'telegram', platformId: 'telegram:42', instance: 'telegram-mega' });
  });

  it('leaves instance undefined when the address has none (default instance)', async () => {
    const event = await routed(to);
    expect(event.instance).toBeUndefined();
  });

  it('drops an instance that is not URL-safe and warns so the downgrade is visible', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const event = await routed({ ...to, instance: 'bad/key' });
      expect(event.instance).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('non-URL-safe to.instance'), { instance: 'bad/key' });
    } finally {
      warn.mockRestore();
    }
  });
});

/** Connect a chat client, deliver one outbound content object, resolve with the line the client reads. */
async function deliverToChat(content: Record<string, unknown>): Promise<Record<string, unknown>> {
  const socket = net.connect(path.join(TEST_DIR, 'cli.sock'));
  const line = new Promise<Record<string, unknown>>((resolve, reject) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const idx = buffer.indexOf('\n');
      if (idx < 0) return;
      const raw = buffer.slice(0, idx);
      Promise.resolve()
        .then(() => JSON.parse(raw))
        .then(resolve, reject);
    });
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('socket closed before a line arrived')));
  });
  const inbound = new Promise<void>((resolve) => {
    nextChat = resolve;
    socket.write(JSON.stringify({ text: 'ping' }) + '\n');
  });
  // A socket failure before the inbound callback rejects here instead of hanging.
  await Promise.race([inbound, line.then(() => undefined)]);
  await getChannelAdapterExact('cli')!.deliver('local', null, { kind: 'chat', content });
  const received = await line;
  socket.end();
  return received;
}

describe('cli channel: chat delivery', () => {
  it('forwards the failureNotice flag on a runner failure notice', async () => {
    const line = await deliverToChat({
      text: "Sorry, something went wrong and I couldn't answer. Whoever runs this NanoClaw can look into it using the logs: https://docs.nanoclaw.dev/operate/troubleshooting#start-here",
      failureNotice: true,
    });
    expect(line).toEqual({
      text: "Sorry, something went wrong and I couldn't answer. Whoever runs this NanoClaw can look into it using the logs: https://docs.nanoclaw.dev/operate/troubleshooting#start-here",
      failureNotice: true,
    });
  });

  it('sends a normal reply without the flag', async () => {
    expect(await deliverToChat({ text: 'pong' })).toEqual({ text: 'pong' });
  });
});

// The runner can't share host modules, so its notice constants have copies here,
// in the chat client and in setup; one test keeps them in sync.
describe('runner notice constants', () => {
  it('match their host copies', () => {
    const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf-8');
    const runner = read('container/agent-runner/src/formatter.ts');
    expect(runner.match(/const FAILURE_NOTICE_FIELD = '([^']+)'/)?.[1]).toBe(FAILURE_NOTICE_FIELD);
    expect(read('scripts/chat.ts').match(/const FAILURE_NOTICE_FIELD = '([^']+)'/)?.[1]).toBe(FAILURE_NOTICE_FIELD);
    const notice = /const GENERIC_FAILURE_NOTICE =\s*"([^"]+)";/;
    expect(runner.match(notice)?.[1]).toBeTruthy();
    expect(read('setup/lib/agent-ping.ts').match(notice)?.[1]).toBe(runner.match(notice)?.[1]);
  });
});
