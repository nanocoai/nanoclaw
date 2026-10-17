import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const child = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: child.exec, spawnSync: child.spawn }));
const prompts = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('@clack/prompts', () => ({
  select: prompts.select,
  password: vi.fn(),
  isCancel: () => false,
  log: { success: vi.fn(), warn: vi.fn() },
}));

import { run } from './auth.js';

let root: string;
const record = () =>
  JSON.parse(fs.readFileSync(path.join(root, 'data', 'onecli', 'provider-credentials.json'), 'utf8')).providers;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-auth-'));
  vi.spyOn(process, 'cwd').mockReturnValue(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

it('records the id of a Claude key saved for a custom endpoint', async () => {
  vi.stubEnv('NANOCLAW_ANTHROPIC_BASE_URL', 'https://llm.example.test');
  vi.stubEnv('NANOCLAW_ANTHROPIC_AUTH_TOKEN', 'fixture-token');
  child.exec.mockReturnValueOnce('{"id":"sec-claude","name":"Anthropic"}');
  await run();
  expect(child.exec.mock.calls[0][1]).toEqual(expect.arrayContaining(['secrets', 'create', '--name', 'Anthropic']));
  expect(record()).toEqual({ claude: ['sec-claude'] });
});

it('records the Anthropic secret a subscription sign-in saved', async () => {
  child.exec
    .mockReturnValueOnce(JSON.stringify({ data: [{ id: 'sec-vercel', name: 'Vercel', type: 'generic' }] }))
    .mockReturnValueOnce(
      JSON.stringify({
        data: [
          { id: 'sec-vercel', name: 'Vercel', type: 'generic' },
          { id: 'sec-sub', name: 'Anthropic', type: 'anthropic' },
        ],
      }),
    );
  prompts.select.mockResolvedValueOnce('subscription');
  child.spawn.mockReturnValueOnce({ status: 0 });
  await run();
  expect(child.exec.mock.calls.every(([, args]) => args.includes('--max') && args.includes('0'))).toBe(true);
  expect(record()).toEqual({ claude: ['sec-sub'] });
});

it('an already saved Anthropic key is recorded; a differently named or OpenCode key does not count as connected', async () => {
  child.exec.mockReturnValueOnce(JSON.stringify({ data: [{ id: 'sec-a', name: 'Anthropic', type: 'anthropic' }] }));
  await run();
  expect(record()).toEqual({ claude: ['sec-a'] });
  expect(prompts.select).not.toHaveBeenCalled();
  fs.rmSync(path.join(root, 'data'), { recursive: true });
  child.exec.mockReturnValueOnce(
    JSON.stringify({
      data: [
        { id: 'sec-oc', name: 'OpenCode anthropic', type: 'generic' },
        { id: 'sec-bob', name: 'Anthropic (Bob)', type: 'anthropic' },
      ],
    }),
  );
  prompts.select.mockResolvedValueOnce('skip');
  await run();
  expect(prompts.select).toHaveBeenCalledOnce();
  expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
});
