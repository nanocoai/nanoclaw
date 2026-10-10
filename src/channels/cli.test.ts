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

import './cli.js';
import { initChannelAdapters, teardownChannelAdapters } from './channel-registry.js';

let nextEvent: ((event: InboundEvent) => void) | null = null;

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
  beforeAll(async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await initChannelAdapters(() => ({
      onInbound() {},
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
