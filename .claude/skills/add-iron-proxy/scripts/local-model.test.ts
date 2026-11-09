import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn(async () => {}));
const prepareLocalModel = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./setup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./setup.js')>()),
  run,
  prepareLocalModel,
}));
const { ironModelEndpoint } = await import('./provider-credentials.js');
const { checkModelList } = await import('./setup.js');

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  run.mockClear();
  prepareLocalModel.mockClear();
});
const project = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-local-'));
  roots.push(root);
  return root;
};
const ok = (body: unknown) => `HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`;

it('prepares a keyless model on this machine without writing any pin', async () => {
  const root = project();
  await ironModelEndpoint('http://host.docker.internal:11434/v1', root).configure();
  expect(prepareLocalModel).toHaveBeenCalledWith('host.docker.internal:11434', root);
  expect(run).not.toHaveBeenCalled();
});
it('only allows the host for an https endpoint', async () => {
  const root = project();
  await ironModelEndpoint('https://models.example.test/v1', root).configure();
  expect(run).toHaveBeenCalledWith(['--allow-host', 'models.example.test'], root);
  expect(prepareLocalModel).not.toHaveBeenCalled();
});
it('names port 80 instead of asking to write out a port', () => {
  expect(() => ironModelEndpoint('http://host.docker.internal:80/v1', project())).toThrow('Port 80 is not supported');
});
it.each([
  'http://host.docker.internal:11434/api',
  'http://host.docker.internal:11434/',
  'http://host.docker.internal:11434/v1beta',
  'http://host.docker.internal:11434/v1/openai',
  'http://host.docker.internal:11434/v1//tenant',
])('refuses a local model path the front would block: %s', (url) => {
  expect(() => ironModelEndpoint(url, project())).toThrow('the path /v1');
});

it.each([ok({ object: 'list', data: [{ id: 'llama3', object: 'model' }] }), ok({ data: [] })])(
  'accepts a direct OpenAI-style model list',
  (response) => {
    expect(() => checkModelList(response, 11434)).not.toThrow();
  },
);
it.each([
  '',
  'HTTP/1.0 302 Found\r\nLocation: http://host.docker.internal:10257/\r\n\r\n',
  'HTTP/1.0 200 OK\r\n\r\n<html>Iron Control</html>',
  ok({}),
  ok({ data: [{ name: 'x' }] }),
  'HTTP/1.1 404 Not Found\r\n\r\n{"data":[]}',
])('refuses a redirect or anything but a model list: %j', (response) => {
  expect(() => checkModelList(response, 10257)).toThrow('did not answer GET /v1/models');
});
