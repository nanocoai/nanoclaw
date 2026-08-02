import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlayboxAdapter, playboxEnabled } from '../playbox.js';

const adapters: Array<ReturnType<typeof createPlayboxAdapter>> = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.teardown()));
});

describe('playbox adapter', () => {
  it('is gated off unless both development environment values are exact', () => {
    expect(playboxEnabled({ NODE_ENV: 'development', NANOCLAW_PLAYBOX: 'true' })).toBe(true);
    expect(playboxEnabled({ NODE_ENV: 'production', NANOCLAW_PLAYBOX: 'true' })).toBe(false);
    expect(playboxEnabled({ NODE_ENV: 'development', NANOCLAW_PLAYBOX: '1' })).toBe(false);
  });

  it('reports fixed metadata and converts inbound sender, reply, and attachments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'playbox-adapter-'));
    const onInbound = vi.fn();
    const onMetadata = vi.fn();
    const adapter = createPlayboxAdapter({ port: 0, attachmentRoot: root });
    adapters.push(adapter);
    await adapter.setup({ onInbound, onMetadata, onInboundEvent: vi.fn(), onAction: vi.fn() });
    await adapter.accept({
      id: 'm1',
      senderId: 'playbox:alice',
      senderName: 'Alice',
      text: 'receipt',
      timestamp: new Date().toISOString(),
      replyToId: 'a1',
      attachments: [{ name: 'r.pdf', type: 'application/pdf', dataBase64: Buffer.from('%PDF-1.7').toString('base64') }],
    });
    expect(onMetadata).toHaveBeenCalledWith('playbox:household', 'Household Expenses', true);
    expect(onInbound).toHaveBeenCalledWith(
      'playbox:household',
      null,
      expect.objectContaining({
        kind: 'chat',
        isGroup: true,
        content: expect.objectContaining({ sender: 'playbox:alice', replyToId: 'a1' }),
      }),
    );
    await adapter.teardown();
    await rm(root, { recursive: true, force: true });
  });

  it('delivers outbound text and typing through the playbox event stream', async () => {
    const adapter = createPlayboxAdapter({ port: 0 });
    adapters.push(adapter);
    await adapter.setup({ onInbound: vi.fn(), onMetadata: vi.fn(), onInboundEvent: vi.fn(), onAction: vi.fn() });
    await adapter.setTyping?.('playbox:household', null);
    await adapter.deliver('playbox:household', null, { kind: 'chat', content: { text: 'saved' } });
    expect(adapter.server.events().map((event) => event.type)).toEqual(['typing', 'outbound']);
  });
});
