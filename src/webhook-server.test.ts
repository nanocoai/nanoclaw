import { describe, it, expect } from 'vitest';

import { resolveListenConfig } from './webhook-server.js';

describe('webhook-server resolveListenConfig', () => {
  it('defaults to loopback so the port is not exposed to the LAN', () => {
    expect(resolveListenConfig({})).toEqual({ port: 3000, bind: '127.0.0.1' });
  });

  it('honors WEBHOOK_PORT when set', () => {
    expect(resolveListenConfig({ WEBHOOK_PORT: '4500' })).toEqual({ port: 4500, bind: '127.0.0.1' });
  });

  it('honors WEBHOOK_BIND for opt-in external exposure', () => {
    expect(resolveListenConfig({ WEBHOOK_BIND: '0.0.0.0' })).toEqual({ port: 3000, bind: '0.0.0.0' });
  });

  it('honors WEBHOOK_BIND for binding to a specific interface', () => {
    expect(resolveListenConfig({ WEBHOOK_BIND: '10.0.0.5' })).toEqual({
      port: 3000,
      bind: '10.0.0.5',
    });
  });

  it('treats an empty WEBHOOK_BIND as unset (falls back to loopback)', () => {
    // An accidental `WEBHOOK_BIND=` in a dotenv file should not silently bind
    // to all interfaces — empty string is falsy and should hit the safe default.
    expect(resolveListenConfig({ WEBHOOK_BIND: '' })).toEqual({ port: 3000, bind: '127.0.0.1' });
  });

  it('combines WEBHOOK_PORT and WEBHOOK_BIND independently', () => {
    expect(resolveListenConfig({ WEBHOOK_PORT: '8080', WEBHOOK_BIND: '0.0.0.0' })).toEqual({
      port: 8080,
      bind: '0.0.0.0',
    });
  });
});
