import { afterEach, expect, it } from 'vitest';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createServer as createSocketServer } from 'node:net';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { processLock, processLockOwner, writePrivate } from '../src/community-portal/index.js';
import { launchSlackJob, readSlackJob, slackJobFile, type SlackJob } from '../src/community-portal/slack-job.js';
import { runSlackJob } from './slack-worker.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(): Promise<{ root: string; job: SlackJob }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nc-slack-job-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const job: SlackJob = {
    id: 'job1',
    status: 'awaiting_approval',
    setupId: 'setup1',
    origin: 'https://portal.example.test',
    serviceBase: 'https://slack.example.test',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    identity: { token: 'install-test-only', account_id: 'acct-test', install_id: 'install-test', deviceId: 'dev_test' },
    app: { appId: 'A1', appToken: 'xapp-test-only' },
    context: { agentName: 'Nova', displayName: 'User', role: 'owner', ownerHandle: 'U123456789' },
  };
  await writePrivate(slackJobFile(root), job);
  return { root, job };
}
async function until(check: () => Promise<boolean>, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(20);
  }
  throw new Error('Background job did not reach the expected state.');
}
async function stopped(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

it('approval two days later finishes the saved app, wires the owner and hands off its welcome without a browser or terminal', async () => {
  const { root, job } = await fixture();
  const created = Date.now() - 2 * 86400_000;
  job.createdAt = new Date(created).toISOString();
  job.expiresAt = new Date(created + 7 * 86400_000).toISOString();
  await writePrivate(slackJobFile(root), job);
  let welcome: any;
  const server = createSocketServer((socket) => {
    let line = '';
    socket.on('data', (chunk) => {
      line += chunk;
    });
    socket.on('end', () => {
      welcome = JSON.parse(line);
    });
  });
  await new Promise<void>((resolve) => server.listen(path.join(root, 'data/cli.sock'), resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const reports: string[] = [];
  let polls = 0;
  await runSlackJob(root, {
    now: Date.now,
    sleep: async () => {},
    report: async (current) => {
      reports.push(current.status);
    },
    receive: async (current, body: any) => {
      expect(current.app.appId).toBe('A1');
      if (body.deliveryId) {
        expect((await readSlackJob(root))?.app.botToken).toBe('xoxb-approved');
        return {};
      }
      if (body.statusOnly) return { status: 'installed' };
      if (++polls === 1) return { status: 'pending_install' };
      return { status: 'installed', bot_token: 'xoxb-approved', delivery_id: 'receipt-two-days-later' };
    },
    install: async (current) => {
      expect(current.context).toEqual(job.context);
      await promisify(execFile)(
        process.execPath,
        [
          '--import',
          path.resolve('node_modules/tsx/dist/loader.mjs'),
          path.resolve('scripts/init-first-agent.ts'),
          '--channel',
          'slack',
          '--user-id',
          current.context.ownerHandle,
          '--platform-id',
          'slack:D123456789',
          '--display-name',
          current.context.displayName,
          '--agent-name',
          current.context.agentName,
          '--role',
          current.context.role,
        ],
        { cwd: root, timeout: 30_000 },
      );
      await until(async () => Boolean(welcome));
      expect(reports).not.toContain('complete');
    },
  });
  expect((await readSlackJob(root))?.status).toBe('complete');
  expect(reports.at(-1)).toBe('complete');
  expect(polls).toBe(2);
  expect(welcome).toMatchObject({
    text: expect.stringContaining('run /welcome'),
    senderId: 'slack:U123456789',
    sender: 'User',
    to: { channelType: 'slack', platformId: 'slack:D123456789', instance: 'slack' },
  });
  const db = new Database(path.join(root, 'data/v2.db'), { readonly: true });
  try {
    expect(db.prepare('SELECT channel_type, platform_id, instance FROM messaging_groups').all()).toEqual([
      { channel_type: 'slack', platform_id: 'slack:D123456789', instance: 'slack' },
    ]);
  } finally {
    db.close();
  }
}, 60_000);

it('survives SIGKILL after durable delivery, retries ACK, serializes with setup and installs once across workers', async () => {
  const { root, job } = await fixture();
  let reads = 0,
    acknowledgements = 0;
  let first!: ChildProcess;
  const server = createServer(async (req, res) => {
    expect(req.url).toBe('/v1/apps/A1/install');
    expect(req.headers.authorization).toBe('Bearer install-test-only');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.setHeader('content-type', 'application/json');
    if (body.statusOnly) {
      res.end('{"status":"installed"}');
      return;
    }
    if (body.deliveryId) {
      acknowledgements++;
      const durable = await readSlackJob(root);
      expect(durable?.app.botToken).toBe('xoxb-test-only');
      expect(durable?.deliveryId).toBe('receipt1');
      if (acknowledgements === 1) {
        first.kill('SIGKILL');
        res.destroy();
        return;
      }
      res.end('{"acknowledged":true}');
      return;
    }
    reads++;
    res.end(JSON.stringify({ status: 'installed', bot_token: 'xoxb-test-only', delivery_id: 'receipt1' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  job.serviceBase = `http://127.0.0.1:${(server.address() as any).port}`;
  await writePrivate(slackJobFile(root), job);
  const script = path.join(root, 'run.mts');
  await writeFile(
    script,
    `import {appendFile} from 'node:fs/promises';
import {runSlackJob} from ${JSON.stringify(pathToFileURL(path.resolve('setup/slack-worker.ts')).href)};
await runSlackJob(${JSON.stringify(root)}, {
 report: async j => { await appendFile(${JSON.stringify(path.join(root, 'progress'))}, j.status+'\\n'); },
 install: async j => { if(j.app.botToken!=='xoxb-test-only')throw Error('missing token'); await appendFile(${JSON.stringify(path.join(root, 'installed'))}, j.app.appId+'\\n'); },
 sleep: async () => new Promise(r=>setTimeout(r,20)),
});`,
  );
  const launch = () => {
    const child = spawn(
      process.execPath,
      ['--import', pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href, script],
      { stdio: 'pipe', env: { ...process.env, NANOCLAW_SETUP_LOCK: '' } },
    );
    let error = '';
    child.stderr?.on('data', (data) => {
      error += data;
    });
    cleanups.push(async () => {
      child.kill('SIGKILL');
      await stopped(child);
      if (child.exitCode && error) throw new Error(error);
    });
    return child;
  };
  const unlock = await processLock(path.join(root, 'data/setup-mutation.lock'));
  expect(unlock).toBeTypeOf('function');
  first = launch();
  await until(async () => acknowledgements === 1);
  await stopped(first);
  expect((await stat(slackJobFile(root))).mode & 0o777).toBe(0o600);
  const second = launch();
  await until(async () => acknowledgements === 2);
  const contender = launch();
  await stopped(contender);
  expect(contender.exitCode).toBe(0);
  await expect(readFile(path.join(root, 'installed'))).rejects.toMatchObject({ code: 'ENOENT' });
  unlock!();
  await until(async () => (await readSlackJob(root))?.status === 'complete');
  await stopped(second);
  expect(second.exitCode).toBe(0);
  expect(await readFile(path.join(root, 'installed'), 'utf8')).toBe('A1\n');
  expect(reads).toBe(1);
  expect(acknowledgements).toBe(2);
  expect((await readSlackJob(root))?.reportedStatus).toBe('complete');
  expect(await readFile(path.join(root, 'progress'), 'utf8')).toContain('complete');
}, 20_000);

it('keeps approval pending through a transient failure, then installs; an apply failure is visible and never loops', async () => {
  const { root } = await fixture();
  let polls = 0,
    applies = 0;
  const statuses: string[] = [];
  await runSlackJob(root, {
    report: async (j) => {
      statuses.push(j.status);
    },
    receive: async (_j, body) => {
      if ('statusOnly' in body) return { status: 'installed' };
      if ('deliveryId' in body) return {};
      polls++;
      if (polls === 1) throw Object.assign(new Error('offline'), { status: 503 });
      if (polls === 2) return { status: 'pending_install' };
      return { status: 'installed', bot_token: 'xoxb-test-only', delivery_id: 'receipt1' };
    },
    sleep: async () => {},
    install: async () => {
      applies++;
      throw new Error('build needs attention');
    },
  });
  expect(polls).toBe(3);
  expect(applies).toBe(1);
  expect((await readSlackJob(root))?.status).toBe('failed');
  expect(statuses.at(-1)).toBe('failed');
});

it('never applies after sign-out or expiry, and resumes completion reporting without reinstalling', async () => {
  const { root, job } = await fixture();
  let applies = 0;
  await runSlackJob(root, {
    report: async () => {
      throw Object.assign(new Error('signed out'), { status: 401 });
    },
    install: async () => {
      applies++;
    },
  });
  expect((await readSlackJob(root))?.error).toBe('sign_in_required');
  expect(applies).toBe(0);
  await writePrivate(slackJobFile(root), { ...job, expiresAt: new Date(0).toISOString() });
  await runSlackJob(root, {
    report: async () => {},
    install: async () => {
      applies++;
    },
  });
  expect((await readSlackJob(root))?.status).toBe('expired');
  expect(applies).toBe(0);
  await writePrivate(slackJobFile(root), { ...job, status: 'complete' });
  await runSlackJob(root, {
    report: async () => {},
    install: async () => {
      applies++;
    },
  });
  expect((await readSlackJob(root))?.reportedStatus).toBe('complete');
  expect(applies).toBe(0);
});

it('the production launcher starts a detached worker and waits for its ready handshake', async () => {
  const { root, job } = await fixture();
  let reports = 0,
    polls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
      /* drain the body */
    }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/device/slack') {
      reports++;
      res.end('{"ok":true}');
    } else {
      expect(req.url).toBe('/v1/apps/A1/install');
      polls++;
      res.end('{"status":"pending_install"}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  job.origin = job.serviceBase = `http://127.0.0.1:${(server.address() as any).port}`;
  await writePrivate(slackJobFile(root), job);
  await symlink(path.resolve('setup'), path.join(root, 'setup'));
  await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'));
  expect(await launchSlackJob(root)).toBe(true);
  const { pid } = processLockOwner(`${slackJobFile(root)}.lock`)!;
  expect(pid).not.toBe(process.pid);
  cleanups.push(async () => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  });
  await until(async () => reports > 0 && polls > 0);
  expect((await readSlackJob(root))?.status).toBe('awaiting_approval');
});

it('recovers an owner from a previous process birth even when its PID has been reused', async () => {
  const { root } = await fixture();
  const file = path.join(root, 'data/reboot.lock');
  const release = await processLock(file);
  expect(release).not.toBeNull();
  release!();
  await writeFile(file, JSON.stringify({ pid: process.pid, nonce: 'old-owner', started: 'previous-boot' }));
  const recovered = await processLock(file);
  expect(recovered).not.toBeNull();
  recovered!();
});
