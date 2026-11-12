import { afterEach, expect, it, vi } from 'vitest';
import type { ChannelRegistration, ChannelSetup } from './adapter.js';

const fixture = vi.hoisted(() => ({
  registrations: new Map<string, ChannelRegistration>(),
  handlers: new Map<string, (event: Record<string, unknown>) => unknown>(),
  send: vi.fn(async () => ({ key: { id: 'sent' } })),
}));
vi.mock('./channel-registry.js', () => ({
  registerChannelAdapter: (name: string, registration: ChannelRegistration) =>
    fixture.registrations.set(name, registration),
}));
vi.mock('../env.js', () => ({ readEnvFile: () => ({ WHATSAPP_ENABLED: 'true', ASSISTANT_HAS_OWN_NUMBER: 'true' }) }));
vi.mock('fs', () => ({ default: { existsSync: () => false, mkdirSync: vi.fn() } }));
vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: () => ({
    ev: {
      on: (event: string, handler: (event: Record<string, unknown>) => unknown) => fixture.handlers.set(event, handler),
    },
    sendMessage: fixture.send,
    sendPresenceUpdate: async () => {},
    groupFetchAllParticipating: async () => ({}),
    end: vi.fn(),
  }),
  useMultiFileAuthState: async () => ({ state: { creds: { me: { id: 'bot' } }, keys: {} }, saveCreds: vi.fn() }),
  makeCacheableSignalKeyStore: () => ({}),
  normalizeMessageContent: (message: unknown) => message,
  Browsers: { macOS: () => [] },
  DisconnectReason: {},
}));
import './whatsapp.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('dispatches the whole real upsert batch while two host decisions are pending', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('2.3000.123456')),
  );
  vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0 as never);
  const adapter = (await fixture.registrations.get('whatsapp')!.factory())!;
  const decisions: Array<(value: 'accepted') => void> = [];
  const onAction = vi.fn((_id: string) => new Promise<'accepted'>((resolve) => decisions.push(resolve)));
  const onInbound = vi.fn<ChannelSetup['onInbound']>();
  const setup = adapter.setup({ onAction, onInbound, onMetadata: vi.fn() } as unknown as ChannelSetup);
  await vi.waitFor(() => expect(fixture.handlers.has('messages.upsert')).toBe(true));
  fixture.handlers.get('connection.update')!({ connection: 'open' });
  await setup;
  try {
    for (const id of ['a', 'b']) {
      await adapter.deliver(`${id}@g.us`, null, {
        kind: 'chat-sdk',
        content: {
          type: 'ask_question',
          questionId: id,
          title: 'Approve',
          question: 'Allow?',
          options: [{ label: 'Approve', value: 'approve', selectedLabel: 'Approved' }],
        },
      });
    }
    fixture.send.mockClear();
    const batch = fixture.handlers.get('messages.upsert')!({
      messages: [
        ['a', '/approve'],
        ['c', 'hello'],
        ['b', '/approve'],
        ['a', 'more'],
        ['d', 'last'],
      ].map(([chat, text], i) => ({
        key: { remoteJid: `${chat}@g.us`, participant: 'owner@s.whatsapp.net', id: `${i}` },
        messageTimestamp: 1,
        message: { conversation: text },
      })),
    });
    // Observe before releasing either decision: awaiting a host answer in the
    // actual messages.upsert loop must fail these assertions.
    await vi.waitFor(
      () => {
        expect(onAction).toHaveBeenCalledTimes(2);
        expect(onInbound).toHaveBeenCalledTimes(3);
      },
      { timeout: 500 },
    );
    await batch;
    expect(onInbound.mock.calls.map(([, , message]) => message)).toEqual(
      ['hello', 'more', 'last'].map((text) => expect.objectContaining({ content: expect.objectContaining({ text }) })),
    );
    expect(onAction.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    expect(fixture.send).not.toHaveBeenCalled();
    decisions.forEach((resolve) => resolve('accepted'));
    await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledTimes(2));
  } finally {
    decisions.forEach((resolve) => resolve('accepted'));
    await adapter.teardown();
  }
});
