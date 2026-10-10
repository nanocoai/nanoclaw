import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ root: '', service: 'running', groups: 0, channels: {} as Record<string, string> }));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync: vi.fn((command: string) => {
    if (command.includes(' is-active ') && host.service === 'stopped') throw new Error('stopped');
    if (command.includes('MainPID')) return '123';
    if (command.startsWith('ps ')) return `node ${host.service === 'other' ? '/other' : host.root}/dist/index.js`;
    if (command.includes('list-unit-files')) return 'nanoclaw.service';
    return '';
  }),
}));
vi.mock('../src/install-slug.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/install-slug.js')>()),
  getLaunchdLabel: () => 'dev.nanoclaw',
  getSystemdUnit: () => 'nanoclaw.service',
}));
vi.mock('../src/env.js', () => ({ readEnvFile: () => host.channels }));
vi.mock('./platform.js', () => ({
  getPlatform: () => 'linux',
  getServiceManager: () => 'systemd',
  isRoot: () => false,
  hasSystemd: () => true,
}));
vi.mock('./central-db-inspection.js', () => ({
  inspectCentralDb: async () => ({ registeredGroups: host.groups, derivedGroups: 0 }),
}));
vi.mock('./lib/registry-state.js', () => ({
  readImageSource: () => 'hardened',
  inspectAgentImage: () => ({ source: 'hardened', registryDigest: 'sha256:fixture' }),
}));
vi.mock('./status.js', () => ({ emitStatus: vi.fn() }));

import { emitStatus } from './status.js';
import { run } from './verify.js';
import { readSlackJob, withSetupLock } from '../src/community-portal/slack-job.js';

beforeEach(() => {
  host.root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-verify-slack-'));
  host.service = 'running';
  host.groups = 0;
  host.channels = {};
  fs.mkdirSync(path.join(host.root, 'data'));
  fs.writeFileSync(path.join(host.root, '.env'), 'ANTHROPIC_API_KEY=fixture-only\n');
  vi.spyOn(process, 'cwd').mockReturnValue(host.root);
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('verify_exit');
  });
  vi.mocked(emitStatus).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(host.root, { recursive: true, force: true });
});

function saveJob(status: string, expiresAt = new Date(Date.now() + 60_000).toISOString()): void {
  fs.writeFileSync(
    path.join(host.root, 'data/slack-install.json'),
    JSON.stringify({
      status,
      expiresAt,
      app: { appId: 'A_TEST', appToken: 'xapp-private-fixture' },
      identity: { token: 'private-install-fixture', account_id: 'acct-fixture', install_id: 'install-fixture' },
    }),
    { mode: 0o600 },
  );
}
const fields = () => vi.mocked(emitStatus).mock.calls.at(-1)?.[1];

describe('verification during background Slack installation', () => {
  it.each(['awaiting_approval', 'installing'])(
    'finishes foreground setup while Slack is %s, before credentials or groups exist',
    async (status) => {
      saveJob(status);
      await expect(run([])).resolves.toBeUndefined();
      expect(fields()).toMatchObject({
        STATUS: 'success',
        SLACK_INSTALL: status,
        WIRING: 'pending_slack_install',
        CONFIGURED_CHANNELS: '',
        CHANNEL_AUTH: '{}',
        REGISTERED_GROUPS: 0,
      });
      expect(JSON.stringify(fields())).not.toMatch(/private-fixture|private-install-fixture/);
    },
  );

  it.each(['failed', 'expired'])('reports a %s worker even if another group is wired', async (status) => {
    saveJob(status);
    host.groups = 1;
    await expect(run([])).rejects.toThrow('verify_exit');
    expect(fields()).toMatchObject({ STATUS: 'failed', SLACK_INSTALL: status });
  });

  it('does not mistake an expired pending job for progress', async () => {
    saveJob('awaiting_approval', new Date(Date.now() - 1000).toISOString());
    await expect(run([])).rejects.toThrow('verify_exit');
    expect(fields()).toMatchObject({ STATUS: 'failed', SLACK_INSTALL: 'expired' });
  });

  it('does not hide an unwired different channel behind pending Slack', async () => {
    saveJob('awaiting_approval');
    host.channels = { TELEGRAM_BOT_TOKEN: 'fixture-only' };
    await expect(run([])).rejects.toThrow('verify_exit');
    expect(fields()).toMatchObject({ STATUS: 'failed', CONFIGURED_CHANNELS: 'telegram' });
  });

  it.each(['stopped', 'other', 'missing_credentials'])('does not hide %s behind pending Slack', async (failure) => {
    saveJob('awaiting_approval');
    if (failure === 'missing_credentials') fs.unlinkSync(path.join(host.root, '.env'));
    else host.service = failure;
    await expect(run([])).rejects.toThrow('verify_exit');
    expect(fields()).toMatchObject({ STATUS: 'failed' });
  });

  it('still fails without a job or a wired group', async () => {
    await expect(run([])).rejects.toThrow('verify_exit');
    expect(fields()).toMatchObject({ STATUS: 'failed' });
  });

  it('reports fully installed Slack normally', async () => {
    saveJob('complete');
    host.groups = 1;
    host.channels = { SLACK_BOT_TOKEN: 'fixture-only', SLACK_APP_TOKEN: 'fixture-only' };
    await expect(run([])).resolves.toBeUndefined();
    expect(fields()).toMatchObject({
      STATUS: 'success',
      SLACK_INSTALL: 'complete',
      CONFIGURED_CHANNELS: 'slack',
      REGISTERED_GROUPS: 1,
    });
    expect(fields()).not.toHaveProperty('WIRING');
  });

  it('lets foreground verification finish and release the real checkout lock so the detached worker can install', async () => {
    saveJob('awaiting_approval');
    const script = path.join(host.root, 'worker.mts');
    const workerModule = new URL('./slack-worker.ts', import.meta.url).href;
    fs.writeFileSync(
      script,
      `import {writeFileSync} from 'node:fs';
import {runSlackJob} from ${JSON.stringify(workerModule)};
await runSlackJob(${JSON.stringify(host.root)}, {
  receive: async (_job, body) => body.statusOnly ? {status:'installed'} : body.deliveryId ? {acknowledged:true} : {status:'installed',bot_token:'xoxb-fixture',delivery_id:'receipt-fixture'},
  report: async () => {},
  install: async () => { writeFileSync(${JSON.stringify(path.join(host.root, 'installed'))}, 'installed'); },
});`,
    );
    let child: ReturnType<typeof spawn> | undefined;
    let transcript = '';
    const until = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 5000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`worker timeout: ${transcript}`);
        await sleep(20);
      }
    };
    try {
      await withSetupLock(async () => {
        const env = { ...process.env };
        delete env.NANOCLAW_SETUP_LOCK;
        child = spawn(
          process.execPath,
          [
            '--import',
            pathToFileURL(path.resolve(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs')).href,
            script,
          ],
          { env, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        child.stdout!.on('data', (data) => {
          transcript += data;
        });
        child.stderr!.on('data', (data) => {
          transcript += data;
        });
        await until(async () => (await readSlackJob(host.root))?.status === 'installing');
        await run([]);
        expect(fields()).toMatchObject({
          STATUS: 'success',
          SLACK_INSTALL: 'installing',
          WIRING: 'pending_slack_install',
        });
        expect(fs.existsSync(path.join(host.root, 'installed'))).toBe(false);
      }, host.root);
      await until(async () => (await readSlackJob(host.root))?.status === 'complete');
      expect(fs.readFileSync(path.join(host.root, 'installed'), 'utf8')).toBe('installed');
      host.groups = 1;
      host.channels = { SLACK_BOT_TOKEN: 'fixture-only', SLACK_APP_TOKEN: 'fixture-only' };
      await run([]);
      expect(fields()).toMatchObject({ STATUS: 'success', SLACK_INSTALL: 'complete', REGISTERED_GROUPS: 1 });
      expect(fields()).not.toHaveProperty('WIRING');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      }
    }
  }, 10_000);
});
