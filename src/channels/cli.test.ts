/**
 * CLI channel — routed-with-reply-to-cli behavior.
 *
 * A routed message (has `to` field) with `reply_to` pointing back to
 * cli/local should claim the chat slot so that deliver() can reach the
 * originating connection. Currently the routed path skips claimChatSlot(),
 * so deliver() finds client===null and returns undefined — the reply is
 * dropped. Task 2 fixes this; this test pins the desired behavior first.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';

// vi.mock must be hoisted before any regular imports that transitively load
// the module being mocked.  DATA_DIR is resolved eagerly in config.ts so we
// replace it here with a per-test temp dir that gets swapped in beforeEach.
let tmpDir = '';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    get DATA_DIR() {
      return tmpDir;
    },
  };
});

import type { InboundEvent, OutboundMessage } from './adapter.js';
import { teardownChannelAdapters } from './channel-registry.js';

describe('cli channel — routed with reply_to=cli claims chat slot', () => {
  let captured: InboundEvent[] = [];
  let resolveInbound: () => void = () => {};
  let inboundCaptured: Promise<void>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
    captured = [];
    inboundCaptured = new Promise<void>((r) => {
      resolveInbound = r;
    });

    // Import fresh cli adapter and init it.  The adapter self-registers on
    // import so we can't re-register, but teardownChannelAdapters() in
    // afterEach clears activeAdapters, and initChannelAdapters() re-runs
    // setup() on every registered factory.
    const { initChannelAdapters } = await import('./channel-registry.js');
    // Side-effect import to ensure cli registers itself (idempotent).
    await import('./cli.js');

    await initChannelAdapters((_adapter) => ({
      onInbound: async () => {},
      onInboundEvent: async (event) => {
        captured.push(event);
        resolveInbound();
      },
      onMetadata: () => {},
      onAction: () => {},
    }));
  });

  afterEach(async () => {
    await teardownChannelAdapters();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('delivers reply to the routed-with-reply-to-cli connection', async () => {
    const sockPath = path.join(tmpDir, 'cli.sock');

    const client = net.connect(sockPath);
    await new Promise<void>((r, rej) => {
      client.once('connect', () => r());
      client.once('error', rej);
    });

    // Always close the client at the end so teardownChannelAdapters() doesn't
    // hang waiting for the server to drain open connections.
    try {
      const lines: string[] = [];
      client.on('data', (chunk) => {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (line.trim()) lines.push(line);
        }
      });

      // Send routed message with reply_to pointing back to cli/local.
      client.write(
        JSON.stringify({
          text: 'hello',
          to: { channelType: 'telegram', platformId: 'tg:123', threadId: null },
          reply_to: { channelType: 'cli', platformId: 'local', threadId: null },
        }) + '\n',
      );

      // Wait deterministically for the inbound event to reach the stub.
      await Promise.race([
        inboundCaptured,
        new Promise<void>((_, rej) => setTimeout(() => rej(new Error('inbound event never captured')), 1000)),
      ]);

      expect(captured).toHaveLength(1);
      expect(captured[0]!.replyTo).toEqual({
        channelType: 'cli',
        platformId: 'local',
        threadId: null,
      });

      // Set up a deterministic promise that resolves when the reply line arrives.
      let resolveDelivered: () => void = () => {};
      const deliveredPromise = new Promise<void>((r) => {
        resolveDelivered = r;
      });
      client.on('data', (chunk) => {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (line.includes('"world"')) resolveDelivered();
        }
      });

      // Now have the cli adapter deliver a response back to 'local'.
      // With the current (broken) behaviour the chat slot was not claimed, so
      // deliver() finds client===null and the line never arrives.
      const { getChannelAdapter } = await import('./channel-registry.js');
      const adapter = getChannelAdapter('cli')!;
      await adapter.deliver('local', null, {
        kind: 'chat',
        content: { text: 'world' },
      } as OutboundMessage);

      // This assertion is what FAILS before Task 2's fix:
      // the reply is silently dropped because the chat slot was never claimed.
      await Promise.race([
        deliveredPromise,
        new Promise<void>((_, rej) => setTimeout(() => rej(new Error('reply never received')), 1000)),
      ]);
      expect(lines.some((l) => l.includes('"world"'))).toBe(true);
    } finally {
      client.destroy();
      // Give the server a moment to notice the connection closed.
      await new Promise<void>((r) => setTimeout(r, 20));
    }
  });
});
