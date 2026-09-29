import { afterEach, expect, it, vi } from 'vitest';
import { gatewayPorts, localModelOrigins } from './iron-proxy-local-model.js';

afterEach(() => vi.unstubAllEnvs());
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NANOCLAW_IRON_CONTROL_PORT: '',
  ONECLI_URL: '',
  ...extra,
});

it('admits only declared authorities on this machine', () => {
  const contracts = [
    { modelAuthorities: ['host.docker.internal:11434', 'models.example.test:8000'] },
    {},
    { modelAuthorities: ['host.docker.internal:8080', 'host.docker.internal:11434'] },
  ];
  expect(localModelOrigins(undefined, contracts, env())).toEqual([
    'host.docker.internal:11434',
    'host.docker.internal:8080',
  ]);
});
it('follows the configured endpoint on each start, so no older pin survives', () => {
  expect(localModelOrigins(undefined, [{ modelAuthorities: ['host.docker.internal:11434'] }], env())).toEqual([
    'host.docker.internal:11434',
  ]);
  expect(localModelOrigins(undefined, [{ modelAuthorities: ['host.docker.internal:8080'] }], env())).toEqual([
    'host.docker.internal:8080',
  ]);
  expect(localModelOrigins(undefined, [{}], env())).toEqual([]);
});
it('never admits port 80 or a gateway port, whatever a provider declares', () => {
  const declared = [80, 10254, 10255, 10257, 19123, 20001, 10999].map((port) => `host.docker.internal:${port}`);
  const running = env({ NANOCLAW_IRON_CONTROL_PORT: '20001', ONECLI_URL: 'http://127.0.0.1:10999' });
  expect(localModelOrigins(19123, [{ modelAuthorities: declared }], running)).toEqual(['host.docker.internal:10257']);
  expect(localModelOrigins(19123, [{ modelAuthorities: declared }], env())).toEqual([
    'host.docker.internal:10999',
    'host.docker.internal:20001',
  ]);
});
it('reserves the OneCLI port whatever host its URL names', () => {
  expect(gatewayPorts(undefined, env({ ONECLI_URL: 'http://192.168.1.10:10999' }))).toContain(10999);
  expect(gatewayPorts(undefined, env({ ONECLI_URL: 'https://remote-gateway.example:11434' }))).toContain(11434);
});
it('uses the running gateway approval port and a process-env Iron Control port', () => {
  expect(gatewayPorts(19123, env({ NANOCLAW_IRON_CONTROL_PORT: '20001' })).sort()).toEqual([
    10254, 10255, 19123, 20001,
  ]);
  expect(gatewayPorts(undefined, env()).sort()).toEqual([10254, 10255, 10257]);
});
