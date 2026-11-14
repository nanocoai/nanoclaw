import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ note: vi.fn(), done: () => {} }));
vi.mock('../src/community-portal/slack-job.js', async (original) => ({
  ...(await original<typeof import('../src/community-portal/slack-job.js')>()),
  withSetupLock: (run: () => Promise<void>) => run(),
  launchSlackJob: async () => {},
  readSlackJob: async () => ({ id: 'job-1', status: 'failed', createdAt: '2026-11-01T00:00:00.000Z', error: 'boom' }),
}));
vi.mock('./portal.js', () => ({ portalEnabled: () => false, offerPortalReminder: vi.fn(), runImagePortal: vi.fn() }));
vi.mock('./lib/setup-config-parse.js', async (original) => ({
  ...(await original<typeof import('./lib/setup-config-parse.js')>()),
  parseFlags: () => ({ help: false, errors: [], values: {} }),
}));
vi.mock('./logs.js', () => ({ reset: vi.fn(), userInput: vi.fn(), complete: vi.fn() }));
vi.mock('./lib/diagnostics.js', () => ({ emit: vi.fn() }));
vi.mock('./lib/theme.js', async (original) => ({
  ...(await original<typeof import('./lib/theme.js')>()),
  note: fixture.note,
}));
vi.mock('./lib/runner.js', async (original) => ({
  ...(await original<typeof import('./lib/runner.js')>()),
  runQuietStep: async () => ({ ok: true, terminal: { fields: { STATUS: 'success' } } }),
}));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  cancel: vi.fn(),
  outro: () => fixture.done(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  log: { message: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-slack-note-'));
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.stubEnv('NANOCLAW_REEXEC_SG', '1');
  vi.stubEnv('NANOCLAW_BOOTSTRAPPED', '1');
  vi.stubEnv('NANOCLAW_AGENT_PROVIDER', 'claude');
  vi.stubEnv('NANOCLAW_TEMPLATE_PATH', '');
  vi.stubEnv('NANOCLAW_SKIP', 'environment,container,gateway,auth,mounts,service,cli-agent,timezone,channel');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

// Verify set the old failed job aside, so the closing note must not call Slack broken.
it('trusts a verify that passed without a Slack job over the saved failed one', async () => {
  const finished = new Promise<void>((resolve) => (fixture.done = resolve));
  await import('./auto.js');
  await finished;
  expect(fixture.note).not.toHaveBeenCalledWith(expect.anything(), 'Slack setup');
});
