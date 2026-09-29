import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./setup.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./setup.js')>()), run }));
const { ironModelEndpoint } = await import('./provider-credentials.js');
const { statePaths } = await import('./setup.js');

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  run.mockClear();
});
function project(pin?: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-pin-'));
  roots.push(root);
  if (pin) {
    fs.mkdirSync(statePaths(root).shared, { recursive: true });
    fs.writeFileSync(statePaths(root).plaintextModels, JSON.stringify(pin));
  }
  return root;
}

it('pins a keyless model on this machine through setup', async () => {
  await ironModelEndpoint('http://host.docker.internal:11434/v1', project()).configure();
  expect(run).toHaveBeenCalledWith(['--allow-plaintext-model', 'host.docker.internal:11434'], expect.any(String));
});
it('clears an older plain-HTTP pin when the endpoint moves to https', async () => {
  const root = project(['host.docker.internal:11434']);
  await ironModelEndpoint('https://models.example.test/v1', root).configure();
  expect(run).toHaveBeenCalledWith(['--allow-host', 'models.example.test', '--clear-plaintext-model'], root);
});
it('only allows the host for https when nothing is pinned', async () => {
  const root = project([]);
  await ironModelEndpoint('https://models.example.test/v1', root).configure();
  expect(run).toHaveBeenCalledWith(['--allow-host', 'models.example.test'], root);
});
it('names port 80 instead of asking to write out a port', () => {
  expect(() => ironModelEndpoint('http://host.docker.internal:80/v1', project())).toThrow('Port 80 is not supported');
});
it.each([
  'http://host.docker.internal:11434/api',
  'http://host.docker.internal:11434/',
  'http://host.docker.internal:11434/v1beta',
])('refuses a local model path the front would block: %s', (url) => {
  expect(() => ironModelEndpoint(url, project())).toThrow('the path /v1');
});
