import { afterEach, describe, expect, it, vi } from 'vitest';
import { permitsConfiguredGatewayRead, permitsUncredentialedGatewayRead } from './gateway-read-policy.js';

afterEach(() => vi.unstubAllEnvs());

it.each(['GET', 'HEAD'])('allows configured %s destinations', (method) => {
  vi.stubEnv('NANOCLAW_GATEWAY_READ_ONLY_HOSTS', 'api.example.test, api.other.test');
  expect(permitsConfiguredGatewayRead({ host: 'API.EXAMPLE.TEST:443', method })).toBe(true);
  expect(permitsConfiguredGatewayRead({ host: 'api.other.test', method })).toBe(true);
});

it.each([
  ['api.example.test', 'POST'],
  ['api.example.test', 'DELETE'],
  ['api.example.test', undefined],
  ['api.example.test', 'get'],
  ['api.example.test.evil.test', 'GET'],
  ['sub.api.example.test', 'GET'],
  ['api.example.test:8443', 'GET'],
  ['api.unknown.test', 'HEAD'],
])('does not exempt %s %s', (host, method) => {
  vi.stubEnv('NANOCLAW_GATEWAY_READ_ONLY_HOSTS', 'api.example.test');
  expect(permitsConfiguredGatewayRead({ host: host!, method })).toBe(false);
});

it.each(['', '*', '*.example.test', 'https://api.example.test', 'api.example.test,', 'api.example.test:443'])(
  'rejects malformed configuration %s',
  (value) => {
    vi.stubEnv('NANOCLAW_GATEWAY_READ_ONLY_HOSTS', value);
    expect(permitsConfiguredGatewayRead({ host: 'api.example.test', method: 'GET' })).toBe(false);
  },
);

describe('uncredentialed reads', () => {
  it.each(['GET', 'HEAD'])('admits an opted-in %s that sends no payload', (method) => {
    vi.stubEnv('NANOCLAW_GATEWAY_UNCREDENTIALED_READS', 'true');
    expect(permitsUncredentialedGatewayRead({ method, sendsPayload: false })).toBe(true);
  });

  it.each([
    ['unset', undefined, { method: 'GET', sendsPayload: false }],
    ['false', 'false', { method: 'GET', sendsPayload: false }],
    ['1', '1', { method: 'GET', sendsPayload: false }],
    ['payload', 'true', { method: 'GET', sendsPayload: true }],
    ['unattested payload', 'true', { method: 'GET' }],
    ['write', 'true', { method: 'POST', sendsPayload: false }],
    ['options', 'true', { method: 'OPTIONS', sendsPayload: false }],
    ['lower-case method', 'true', { method: 'get', sendsPayload: false }],
    ['missing method', 'true', { sendsPayload: false }],
  ])('refuses %s', (_name, flag, destination) => {
    if (flag !== undefined) vi.stubEnv('NANOCLAW_GATEWAY_UNCREDENTIALED_READS', flag);
    expect(permitsUncredentialedGatewayRead(destination)).toBe(false);
  });
});
