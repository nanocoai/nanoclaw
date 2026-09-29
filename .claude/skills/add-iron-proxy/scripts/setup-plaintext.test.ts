import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { checkModelList, gatewayPorts, validatePlaintextModel } from './setup.js';

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs();
});
function project(env = ''): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-plaintext-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, '.env'), env);
  return root;
}

it.each(['host.docker.internal:8000', ' HOST.docker.internal:65535 '])('accepts the pinned local model %s', (raw) => {
  expect(validatePlaintextModel(raw)).toBe(raw.trim().toLowerCase());
});
it.each([
  'host.docker.internal',
  'host.docker.internal:0',
  'host.docker.internal:80',
  'host.docker.internal:65536',
  'host.docker.internal:08000',
  'models.example.test:8000',
  'sub.host.docker.internal:8000',
  '172.17.0.1:8000',
])('refuses %s as a plaintext model endpoint', (raw) => {
  expect(() => validatePlaintextModel(raw)).toThrow('must be host.docker.internal:<port> (not 80)');
});

it('lists the approval, Iron Control and OneCLI ports as never pinnable', () => {
  vi.stubEnv('NANOCLAW_IRON_CONTROL_PORT', '');
  vi.stubEnv('ONECLI_URL', '');
  const root = project('NANOCLAW_IRON_PROXY_APPROVAL_PORT=19123\nONECLI_URL=http://127.0.0.1:10999\n');
  expect(gatewayPorts(root).sort()).toEqual([10254, 10255, 10257, 10999, 19123]);
});
it('derives the default approval port from the install slug', () => {
  vi.stubEnv('NANOCLAW_IRON_CONTROL_PORT', '');
  vi.stubEnv('ONECLI_URL', '');
  const ports = gatewayPorts(project());
  expect(ports.some((port) => port >= 19000 && port < 29000)).toBe(true);
});

it.each([JSON.stringify({ object: 'list', data: [{ id: 'llama3', object: 'model' }] }), JSON.stringify({ data: [] })])(
  'accepts an OpenAI-style model list: %s',
  (body) => {
    expect(() => checkModelList(body, 11434)).not.toThrow();
  },
);
it.each([
  '',
  '<html>Iron Control</html>',
  '{}',
  JSON.stringify({ data: [{ name: 'x' }] }),
  JSON.stringify({ models: [] }),
])('refuses a port that does not answer with a model list: %j', (body) => {
  expect(() => checkModelList(body, 10257)).toThrow('did not answer GET /v1/models');
});
