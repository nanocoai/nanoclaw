import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() });
    setImmediate(() => child.emit('message', { type: 'slack-worker-ready' }));
    return child;
  }),
}));
vi.mock('./install-identity.js', () => ({
  readInstallIdentity: async () => ({ token: 'install-fixture', accountId: 'acct-fixture', installId: 'install-id' }),
}));

import { queueSlackJob, readSlackJob, slackJobFile } from './slack-job.js';

const FIRST_START = '2026-11-01T00:00:00.000Z';
const context = { agentName: 'Andy', displayName: 'Alex', role: 'owner' as const, ownerHandle: 'U0FIXTURE' };
let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-slack-job-'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(
    path.join(root, 'data/community-portal.json'),
    JSON.stringify({
      origin: 'https://portal.example.com',
      deviceId: 'device-fixture',
      slackSetup: { setupId: 'setup-2', app: { appId: 'A_SAME', appToken: 'xapp-fixture' } },
    }),
  );
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function saveJob(appId: string, status: string): void {
  fs.writeFileSync(
    slackJobFile(root),
    JSON.stringify({
      id: 'job-1',
      status,
      createdAt: FIRST_START,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      setupId: 'setup-1',
      app: { appId, appToken: 'xapp-fixture' },
      context,
    }),
  );
}

// Verify sets a failed job aside once a Slack chat was wired after the job
// began. A retry re-runs a wiring that already exists, so its time stays.
describe('a Slack job retried for the same app', () => {
  it.each(['failed', 'expired'])('keeps the first start time when the last job %s', async (status) => {
    saveJob('A_SAME', status);
    await queueSlackJob(context, root);
    const job = await readSlackJob(root);
    expect(job?.id).not.toBe('job-1');
    expect(job?.status).toBe('awaiting_approval');
    expect(job?.createdAt).toBe(FIRST_START);
  });

  it('starts the clock again for another app', async () => {
    saveJob('A_OTHER', 'failed');
    await queueSlackJob(context, root);
    expect((await readSlackJob(root))?.createdAt).not.toBe(FIRST_START);
  });
});
