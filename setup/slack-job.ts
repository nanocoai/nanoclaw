import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, open } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { writePrivate, SetupClient } from './portal-client.mjs';
import type { OperatorRole } from './lib/role-prompt.js';

export interface SlackJob {
  id: string;
  status: 'awaiting_approval' | 'installing' | 'complete' | 'failed' | 'expired';
  createdAt: string;
  expiresAt: string;
  setupId: string;
  origin: string;
  serviceBase: string;
  identity: Record<string, any>;
  app: { appId: string; appToken: string; botToken?: string };
  deliveryId?: string;
  acknowledged?: boolean;
  context: {
    agentName: string;
    displayName: string;
    role: OperatorRole;
    ownerHandle: string;
    templateAgentId?: string;
  };
  error?: string;
  reportedStatus?: string;
}
export const slackJobFile = (root = process.cwd()) => path.join(root, 'data/slack-install.json');
export async function readSlackJob(root = process.cwd()): Promise<SlackJob | null> {
  try {
    return JSON.parse(await readFile(slackJobFile(root), 'utf8'));
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** Public progress only; an abandoned or expired job must not look active. */
export function slackJobStatus(job: SlackJob | null, now = Date.now()): SlackJob['status'] | undefined {
  if (!job) return undefined;
  if (!['awaiting_approval', 'installing', 'complete', 'failed', 'expired'].includes(job.status)) return 'failed';
  if (['awaiting_approval', 'installing'].includes(job.status) && !(Date.parse(job.expiresAt) > now)) return 'expired';
  return job.status;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code !== 'ESRCH';
  }
};

// PID numbers can be reused after a crash or reboot. Compare process birth,
// including Linux's boot identity, before treating a recorded owner as live.
function processIdentity(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return `${boot}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
    }
    return (
      execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}
type LockOwner = { pid: number; nonce: string; started: string };
function ownerAlive(owner: LockOwner): boolean {
  if (!alive(owner.pid)) return false;
  const current = processIdentity(owner.pid);
  return !current || !owner.started || current === owner.started;
}

// SQLite serializes stale-owner recovery and acquisition in one transaction.
// Checking a PID and unlinking a plain lock file has a race: two recovering
// workers can otherwise remove a newly acquired lock and both install.
function lockOwner(file: string): LockOwner | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return db.prepare('SELECT pid, nonce, started FROM owner WHERE id = 1').get() as LockOwner | undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
export async function processLock(file: string): Promise<(() => void) | null> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = await open(file, 'a', 0o600);
  await fd.close();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  const owner = { pid: process.pid, nonce: randomUUID(), started: processIdentity(process.pid) || '' };
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, nonce TEXT NOT NULL, started TEXT NOT NULL)',
    );
    db.exec('BEGIN IMMEDIATE');
    const previous = db.prepare('SELECT pid, nonce, started FROM owner WHERE id = 1').get() as LockOwner | undefined;
    if (previous && ownerAlive(previous)) {
      db.exec('COMMIT');
      db.close();
      return null;
    }
    db.prepare('INSERT OR REPLACE INTO owner (id, pid, nonce, started) VALUES (1, ?, ?, ?)').run(
      owner.pid,
      owner.nonce,
      owner.started,
    );
    db.exec('COMMIT');
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        db.prepare('DELETE FROM owner WHERE id = 1 AND pid = ? AND nonce = ?').run(owner.pid, owner.nonce);
      } finally {
        db.close();
        process.removeListener('exit', release);
      }
    };
    process.once('exit', release);
    return release;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    try {
      db.close();
    } catch {}
    throw error;
  }
}

export async function withSetupLock<T>(run: () => Promise<T>, root = process.cwd()): Promise<T> {
  const file = path.join(root, 'data/setup-mutation.lock');
  const inherited = process.env.NANOCLAW_SETUP_LOCK;
  if (inherited) {
    try {
      const owner = lockOwner(file);
      if (owner?.nonce === inherited && ownerAlive(owner)) return run();
    } catch {}
  }
  let release: (() => void) | null;
  while (!(release = await processLock(file))) await sleep(1000);
  process.env.NANOCLAW_SETUP_LOCK = lockOwner(file)!.nonce;
  try {
    return await run();
  } finally {
    delete process.env.NANOCLAW_SETUP_LOCK;
    release();
  }
}

export async function launchSlackJob(root = process.cwd()): Promise<boolean> {
  const job = await readSlackJob(root);
  if (
    !job ||
    !(
      ['awaiting_approval', 'installing'].includes(job.status) ||
      (job.status === 'complete' && job.reportedStatus !== 'complete')
    )
  )
    return false;
  const env = { ...process.env };
  delete env.NANOCLAW_SETUP_LOCK;
  delete env.NANOCLAW_TEMPLATE_AGENT_ID;
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'setup/slack-worker.ts')], {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('The Slack background worker could not start. Resume the Slack setup step.'));
    }, 10_000);
    child.once('message', (message) => {
      if ((message as { type?: string })?.type !== 'slack-worker-ready') return;
      clearTimeout(timer);
      resolve();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('The Slack background worker failed to start. Resume the Slack setup step.'));
    });
  });
  child.unref();
  return true;
}

export async function queueSlackJob(context: SlackJob['context'], root = process.cwd()): Promise<void> {
  const local = JSON.parse(await readFile(path.join(root, 'data/community-portal.json'), 'utf8'));
  const saved = local.slackSetup;
  if (!saved?.app?.appToken || !local.registryAccount?.token)
    throw new Error('Slack credentials were not saved. Restart the Slack step.');
  const prior = await readSlackJob(root);
  if (prior && prior.app.appId !== saved.app.appId && ['awaiting_approval', 'installing'].includes(prior.status))
    throw new Error('A Slack installation is already running in this checkout.');
  if (!prior || prior.app.appId !== saved.app.appId || ['failed', 'expired'].includes(prior.status)) {
    const job: SlackJob = {
      id: randomUUID(),
      status: saved.app.botToken ? 'installing' : 'awaiting_approval',
      createdAt: new Date().toISOString(),
      expiresAt:
        prior && prior.app.appId === saved.app.appId
          ? prior.expiresAt
          : new Date(Date.now() + 7 * 86400_000).toISOString(),
      setupId: saved.setupId,
      origin: local.origin,
      serviceBase: saved.serviceBase || 'https://slack.nanoclaw.dev',
      identity: { privateKey: local.privateKey, registryAccount: local.registryAccount, deviceId: local.deviceId },
      app: prior && prior.app.appId === saved.app.appId ? prior.app : saved.app,
      context,
      ...(prior && prior.app.appId === saved.app.appId
        ? { deliveryId: prior.deliveryId, acknowledged: prior.acknowledged }
        : {}),
    };
    await writePrivate(slackJobFile(root), job);
  }
  await launchSlackJob(root);
}

export function slackProgressClient(job: SlackJob): SetupClient {
  // Use the job's immutable credential snapshot. Never open/save the foreground
  // portal journal: other perk activations may be using it at the same time.
  const client = new SetupClient({
    origin: job.origin,
    file: '',
    label: '',
    token: job.identity.registryAccount.token,
  });
  client.local = job.identity;
  return client;
}
