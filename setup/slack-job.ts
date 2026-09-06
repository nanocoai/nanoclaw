import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { writePrivate, SetupClient, processLock, processLockOwner } from './portal-client.mjs';
export { processLock } from './portal-client.mjs';
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
export async function withSetupLock<T>(run: () => Promise<T>, root = process.cwd()): Promise<T> {
  const file = path.join(root, 'data/setup-mutation.lock');
  const inherited = process.env.NANOCLAW_SETUP_LOCK;
  if (inherited) {
    try {
      const owner = processLockOwner(file);
      if (owner?.nonce === inherited) return run();
    } catch {}
  }
  let release: (() => void) | null;
  while (!(release = await processLock(file))) await sleep(1000);
  process.env.NANOCLAW_SETUP_LOCK = processLockOwner(file)!.nonce;
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
  // The host supervisor may check on every cell update. A healthy owner is
  // already polling Slack; do not spawn a losing process for each check.
  if (processLockOwner(`${slackJobFile(root)}.lock`)) return false;
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
