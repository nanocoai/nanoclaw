import { afterEach, expect, it, vi } from 'vitest';
import { permitsConfiguredGatewayRead } from './gateway-read-policy.js';

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
