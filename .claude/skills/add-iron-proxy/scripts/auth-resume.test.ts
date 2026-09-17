import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import * as prompts from '@clack/prompts';
import { run } from './auth.js';
import { controlPaths } from './control.js';

vi.mock('@clack/prompts', () => ({
  isCancel: () => false,
  select: vi.fn(async () => 'oauth'),
  password: vi.fn(async () => 'sk-ant-oat-fixture'),
  log: { success: vi.fn(), warn: vi.fn() },
}));
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-auth-resume-'));
  let credential: any;
  let granted = false;
  let unavailable = false;
  let failGrant = false;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const resource = req.url;
    let data: unknown;
    if (unavailable) {
      res.writeHead(503);
      res.end();
      return;
    }
    if (resource === '/api/v1/static_secrets/nanoclaw-model' && req.method === 'PUT') {
      const value = JSON.parse(Buffer.concat(chunks).toString()).data;
      credential = { ...value, id: 'model-id', foreign_id: 'nanoclaw-model', source: undefined };
      data = credential;
    } else if (resource?.startsWith('/api/v1/static_secrets/lookup/') && resource.endsWith('/nanoclaw-model')) {
      if (!credential) {
        res.writeHead(404);
        res.end();
        return;
      }
      data = credential;
    } else if (resource === '/api/v1/principals/principal/roles') data = [];
    else if (resource === '/api/v1/static_secrets/model-id') data = credential;
    else if (resource?.startsWith('/api/v1/principals/principal/grants'))
      data = granted ? [{ static_secret_id: 'model-id' }] : [];
    else if (resource === '/api/v1/grants') {
      if (failGrant) {
        failGrant = false;
        res.writeHead(503);
        res.end();
        return;
      }
      granted = true;
      data = { id: 'grant-id' };
    } else {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error) => {
      fs.rmSync(root, { recursive: true, force: true });
      reject(error);
    });
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  const paths = controlPaths(root);
  fs.mkdirSync(paths.directory, { recursive: true });
  fs.writeFileSync(paths.environment, 'IRON_CONTROL_INITIAL_API_KEY=fixture-only\n', { mode: 0o600 });
  fs.writeFileSync(paths.registration, JSON.stringify({ principalId: 'principal', proxyId: 'proxy' }));
  fs.writeFileSync(
    path.join(root, '.env'),
    `NANOCLAW_IRON_CONTROL_PORT=${port}\nNANOCLAW_IRON_CONTROL_URL=http://127.0.0.1:${port}\n`,
  );
  for (const key of [
    'NANOCLAW_ANTHROPIC_API_KEY',
    'ANTHROPIC_API_KEY',
    'NANOCLAW_ANTHROPIC_BASE_URL',
    'NANOCLAW_ANTHROPIC_AUTH_TOKEN',
    'NANOCLAW_IRON_CONTROL_PORT',
  ])
    vi.stubEnv(key, '');
  cleanup = async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    fs.rmSync(root, { recursive: true, force: true });
  };
  return {
    root,
    failNextGrant() {
      failGrant = true;
    },
    outage() {
      unavailable = true;
    },
  };
}

it('resumes a managed OAuth login after an interrupted grant without repeating authorization', async () => {
  const control = await fixture();
  control.failNextGrant();
  await expect(run('claude', control.root)).rejects.toThrow('503');
  for (let retry = 0; retry < 3; retry++) await run('claude', control.root);
  expect(prompts.select).toHaveBeenCalledTimes(1);
  expect(prompts.password).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(path.join(control.root, '.env'), 'utf8')).toContain(
    'NANOCLAW_IRON_PROXY_AUTH_ENV=CLAUDE_CODE_OAUTH_TOKEN',
  );
  expect(fs.existsSync(path.join(control.root, 'data/session-materials/iron-proxy/shared/upstream-secret'))).toBe(
    false,
  );
});

it('reports a control outage instead of asking a connected user to sign in again', async () => {
  const control = await fixture();
  await run('claude', control.root);
  control.outage();
  await expect(run('claude', control.root)).rejects.toThrow('503');
  expect(prompts.select).toHaveBeenCalledTimes(1);
});
