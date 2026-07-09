/**
 * Regression test: Discord Gateway custom_id parsing in the Chat SDK bridge.
 *
 * @chat-adapter/discord encodes button custom_id as "<actionId>\n<value>"
 * (DISCORD_CUSTOM_ID_DELIMITER = "\n"). Before the fix, handleForwardedEvent
 * didn't strip this suffix before parsing — tail ended up as "0\n0" instead
 * of "0", which failed the /^\d+$/ digit check in resolveSelectedOption, so
 * every button tap was dispatched with the raw "0\n0" string. Since the
 * approval handler only accepts "approve" and forwards anything else to
 * finalizeReject, BOTH the Approve and Reject buttons always rejected.
 */
import http from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

import type { ChannelSetup } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';

/** POST JSON to a local URL using Node.js http (bypasses the fetch spy). */
function postJson(url: string, body: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const { hostname, port, pathname } = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname,
        port: Number(port),
        path: pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

describe('chat-sdk-bridge — Discord Gateway custom_id parsing', () => {
  let capturedWebhookUrl: string | undefined;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    capturedWebhookUrl = undefined;
    // Intercept the Discord interaction-callback fetch so the test doesn't hit
    // the real Discord API. Node-level http.request (used by postJson) is NOT
    // intercepted — it connects to the actual local HTTP server.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}'));

    const { initTestDb } = await import('../db/index.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    runMigrations(initTestDb());
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    const { closeDb } = await import('../db/index.js');
    closeDb();
  });

  function makeGatewayAdapter(): Adapter {
    return {
      name: 'discord',
      initialize: async () => {},
      channelIdFromThreadId: (t: string) => `discord:${t}`,
      // Capture the webhookUrl the bridge passes to the gateway listener.
      startGatewayListener: async (_opts: unknown, _dur: unknown, _signal: unknown, webhookUrl: string) => {
        capturedWebhookUrl = webhookUrl;
        return new Response();
      },
    } as unknown as Adapter;
  }

  it('strips the Discord \\n-encoded value suffix so the option index resolves correctly', async () => {
    const actions: Array<{ questionId: string; option: string }> = [];
    const bridge = createChatSdkBridge({
      adapter: makeGatewayAdapter(),
      supportsThreads: true,
    });

    await bridge.setup({
      onInbound: async () => {},
      onInboundEvent: async () => {},
      onMetadata: () => {},
      onAction: (questionId: string, selectedOption: string) => {
        actions.push({ questionId, option: selectedOption });
      },
    } as unknown as ChannelSetup);

    expect(capturedWebhookUrl).toBeTruthy();

    // Simulate a Discord button click. @chat-adapter/discord encodes custom_id
    // as "<actionId>\n<value>", so for option index 0 of question "appr-q1":
    //   actionId = "ncq:appr-q1:0",  value = "0"  →  custom_id = "ncq:appr-q1:0\n0"
    await postJson(capturedWebhookUrl!, {
      type: 'GATEWAY_INTERACTION_CREATE',
      data: {
        type: 3, // MessageComponent (button click)
        id: 'interaction-id',
        token: 'interaction-token',
        data: { custom_id: 'ncq:appr-q1:0\n0' },
        user: { id: 'user-1', username: 'admin' },
        message: { embeds: [{ title: 'Approval Request', description: 'Approve this action?' }] },
      },
    });

    // HTTP handling is async; allow the event loop to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(actions).toHaveLength(1);
    expect(actions[0].questionId).toBe('appr-q1');

    // Before fix: option = "0\n0" (newline contaminated tail, digit regex failed,
    //             raw string returned → approval handler rejects everything)
    // After fix:  option = "0" (clean index, resolveSelectedOption can index into options)
    expect(actions[0].option).toBe('0');
    expect(actions[0].option).not.toContain('\n');

    await bridge.teardown();
  });

  it('also handles the Reject button (index 1) without newline contamination', async () => {
    const actions: Array<{ questionId: string; option: string }> = [];
    const bridge = createChatSdkBridge({
      adapter: makeGatewayAdapter(),
      supportsThreads: true,
    });

    await bridge.setup({
      onInbound: async () => {},
      onInboundEvent: async () => {},
      onMetadata: () => {},
      onAction: (questionId: string, selectedOption: string) => {
        actions.push({ questionId, option: selectedOption });
      },
    } as unknown as ChannelSetup);

    // Option index 1 → custom_id = "ncq:appr-q2:1\n1"
    await postJson(capturedWebhookUrl!, {
      type: 'GATEWAY_INTERACTION_CREATE',
      data: {
        type: 3,
        id: 'interaction-id-2',
        token: 'interaction-token-2',
        data: { custom_id: 'ncq:appr-q2:1\n1' },
        user: { id: 'user-1', username: 'admin' },
        message: { embeds: [{ title: 'Approval Request', description: 'Approve?' }] },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(actions).toHaveLength(1);
    expect(actions[0].questionId).toBe('appr-q2');
    expect(actions[0].option).toBe('1');
    expect(actions[0].option).not.toContain('\n');

    await bridge.teardown();
  });
});
