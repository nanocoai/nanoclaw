import { describe, expect, it } from 'vitest';

import { isEnvProxyActive, resolveGatewayModules, unwrapForwardedSnapshot, withNativeWebSocket } from './discord.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function forwardPayload(snapshotMessage: Record<string, any> | null, overrides: Record<string, any> = {}) {
  return {
    id: '123',
    content: '',
    attachments: [],
    message_reference: { type: 1, channel_id: 'c1', message_id: 'm1' },
    ...(snapshotMessage ? { message_snapshots: [{ message: snapshotMessage }] } : {}),
    ...overrides,
  };
}

describe('unwrapForwardedSnapshot', () => {
  it('unwraps forwarded text into content with a label', () => {
    const data = forwardPayload({ content: 'hello from the past', attachments: [] });
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('[Forwarded message]\nhello from the past');
  });

  it('unwraps attachment-only forwards: label + merged attachments', () => {
    const att = { filename: 'photo.png', content_type: 'image/png', size: 1234, url: 'https://cdn.example/photo.png' };
    const data = forwardPayload({ content: '', attachments: [att] });
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('[Forwarded message]');
    expect(data.attachments).toEqual([att]);
  });

  it('merges snapshot attachments after existing ones', () => {
    const existing = { filename: 'own.txt', content_type: 'text/plain', size: 1, url: 'https://cdn.example/own.txt' };
    const fwd = { filename: 'fwd.jpg', content_type: 'image/jpeg', size: 2, url: 'https://cdn.example/fwd.jpg' };
    const data = forwardPayload({ content: 'look', attachments: [fwd] }, { attachments: [existing] });
    unwrapForwardedSnapshot(data);
    expect(data.attachments).toEqual([existing, fwd]);
    expect(data.content).toBe('[Forwarded message]\nlook');
  });

  it('leaves plain messages untouched', () => {
    const data = { id: '1', content: 'hi', attachments: [] };
    unwrapForwardedSnapshot(data);
    expect(data).toEqual({ id: '1', content: 'hi', attachments: [] });
  });

  it('leaves normal replies (type 0) untouched', () => {
    const data = {
      id: '1',
      content: 'a reply',
      attachments: [],
      message_reference: { type: 0, message_id: 'm0' },
      referenced_message: { content: 'original', author: { username: 'alice' } },
    };
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('a reply');
  });

  it('is a no-op when a forward has no snapshots', () => {
    const data = forwardPayload(null);
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('');
    expect(data.attachments).toEqual([]);
  });

  it('joins multiple snapshots', () => {
    const data = forwardPayload(null, {
      message_snapshots: [
        { message: { content: 'one', attachments: [] } },
        { message: { content: 'two', attachments: [] } },
      ],
    });
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('[Forwarded message]\none\ntwo');
  });
});

describe('isEnvProxyActive', () => {
  it('is off when no proxy is configured', () => {
    expect(isEnvProxyActive({ NODE_USE_ENV_PROXY: '1' }, [])).toBe(false);
  });

  it('is off when a proxy is set but Node is not routing through it', () => {
    expect(isEnvProxyActive({ HTTPS_PROXY: 'http://proxy.example:8080' }, [])).toBe(false);
  });

  it('is on with a proxy and NODE_USE_ENV_PROXY=1', () => {
    expect(isEnvProxyActive({ HTTPS_PROXY: 'http://proxy.example:8080', NODE_USE_ENV_PROXY: '1' }, [])).toBe(true);
  });

  it('is on with a lowercase proxy var and --use-env-proxy', () => {
    expect(isEnvProxyActive({ http_proxy: 'http://proxy.example:8080' }, ['--use-env-proxy'])).toBe(true);
  });

  it('is on with --use-env-proxy in NODE_OPTIONS', () => {
    expect(
      isEnvProxyActive(
        { HTTP_PROXY: 'http://proxy.example:8080', NODE_OPTIONS: '--max-old-space-size=512 --use-env-proxy' },
        [],
      ),
    ).toBe(true);
  });
});

describe('withNativeWebSocket', () => {
  class FakeWs {}
  class FakeNative {}

  it('exposes the native constructor only while the gateway loads', () => {
    const ws = { WebSocket: FakeWs as unknown };
    let seen: unknown;
    withNativeWebSocket(ws, FakeNative, () => {
      seen = ws.WebSocket;
    });
    expect(seen).toBe(FakeNative);
    expect(ws.WebSocket).toBe(FakeWs);
  });

  it('restores the original constructor when loading throws', () => {
    const ws = { WebSocket: FakeWs as unknown };
    expect(() =>
      withNativeWebSocket(ws, FakeNative, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(ws.WebSocket).toBe(FakeWs);
  });
});

describe('resolveGatewayModules', () => {
  it('finds the ws package that @discordjs/ws loads', () => {
    const { ws, loadGateway } = resolveGatewayModules();
    expect(typeof ws.WebSocket).toBe('function');
    expect((ws.WebSocket as { OPEN?: number }).OPEN).toBe(1);
    expect(typeof loadGateway).toBe('function');
  });
});
