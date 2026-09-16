import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { processLock, writePrivate } from '../src/community-portal/index.js';
import {
  readSlackJob,
  slackJobFile,
  slackProgressClient,
  withSetupLock,
  type SlackJob,
} from '../src/community-portal/slack-job.js';

type Delivery = { status?: string; bot_token?: string; delivery_id?: string };
export interface WorkerDependencies {
  receive(job: SlackJob, body: object): Promise<Delivery>;
  install(job: SlackJob): Promise<void>;
  report(job: SlackJob): Promise<void>;
  sleep(ms: number): Promise<unknown>;
  now(): number;
}
async function receive(job: SlackJob, body: object): Promise<Delivery> {
  const base = new URL(job.serviceBase);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
  )
    throw Object.assign(new Error('Invalid Slack service origin.'), { code: 'invalid_service' });
  const response = await fetch(`${base.origin}/v1/apps/${encodeURIComponent(job.app.appId)}/install`, {
    method: 'POST',
    headers: { authorization: `Bearer ${job.identity.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if (!response.ok) throw Object.assign(new Error('Slack installation request failed.'), { status: response.status });
  return response.json() as Promise<Delivery>;
}
async function install(job: SlackJob): Promise<void> {
  const { runChannelSkill } = await import('./channels/run-channel-skill.js');
  if (job.context.templateAgentId) process.env.NANOCLAW_TEMPLATE_AGENT_ID = job.context.templateAgentId;
  await runChannelSkill('slack', job.context.displayName, {
    agentName: job.context.agentName,
    role: job.context.role,
    reuse: false,
    requireCompanions: true,
    inputs: {
      connection: 'provisioned',
      bot_token: job.app.botToken!,
      app_token: job.app.appToken,
      owner_handle: job.context.ownerHandle,
    },
    resolveInput: async () => {
      throw new Error('Slack needs an additional input. Resume the Slack setup step.');
    },
    confirm: async () => false,
    openUrl: async () => {},
    fail: async () => {
      throw new Error('Slack channel installation needs attention.');
    },
  });
}
export async function runSlackJob(
  root = process.cwd(),
  overrides: Partial<WorkerDependencies> = {},
  ready: () => void = () => {},
): Promise<void> {
  const release = await processLock(`${slackJobFile(root)}.lock`);
  ready();
  if (!release) return;
  try {
    const job = await readSlackJob(root);
    if (!job || ['failed', 'expired'].includes(job.status)) return;
    const deps: WorkerDependencies = {
      receive,
      install,
      sleep,
      now: Date.now,
      report: async (current) => {
        await slackProgressClient(current).request('POST', '/api/v1/device/slack', {
          appId: current.app.appId,
          setupId: current.setupId,
          status: current.status,
        });
      },
      ...overrides,
    };
    const save = () => writePrivate(slackJobFile(root), job);
    let reported = job.reportedStatus;
    const report = async () => {
      if (reported === job.status) return;
      try {
        await deps.report(job);
        reported = job.status;
        job.reportedStatus = reported;
        await save();
      } catch (error: any) {
        if ([401, 403].includes(error.status)) throw error;
      }
    };
    while (deps.now() < Date.parse(job.expiresAt)) {
      let applying = false;
      try {
        await report();
        if (job.status === 'complete') {
          if (reported === 'complete') return;
          await deps.sleep(30_000);
          continue;
        }
        if (!job.app.botToken) {
          const delivery = await deps.receive(job, {});
          if (delivery.status === 'deleted') throw Object.assign(new Error(), { code: 'app_revoked' });
          if (!delivery.bot_token) {
            if (delivery.status === 'installed') throw Object.assign(new Error(), { code: 'credential_unavailable' });
            await deps.sleep(30_000);
            continue;
          }
          if (!delivery.delivery_id || !delivery.bot_token.startsWith('xoxb-'))
            throw Object.assign(new Error(), { code: 'invalid_delivery' });
          job.app.botToken = delivery.bot_token;
          job.deliveryId = delivery.delivery_id;
          job.status = 'installing';
          // This fsync + atomic rename MUST precede acknowledgement. A lost
          // response or crash replays the same receipt to this installation.
          await save();
        }
        if (job.deliveryId && !job.acknowledged) {
          await deps.receive(job, { deliveryId: job.deliveryId });
          job.acknowledged = true;
          await save();
        }
        job.status = 'installing';
        await save();
        await report();
        await withSetupLock(async () => {
          // Check revocation again after a potentially long wait for setup.
          const current = await deps.receive(job, { statusOnly: true });
          if (current.status !== 'installed') throw Object.assign(new Error(), { code: 'app_revoked' });
          await deps.report(job);
          applying = true;
          await deps.install(job);
          job.status = 'complete';
          await save();
        }, root);
        await report();
      } catch (error: any) {
        if (
          [401, 403, 404].includes(error.status) ||
          ['app_revoked', 'credential_unavailable', 'invalid_delivery', 'invalid_service'].includes(error.code) ||
          applying
        ) {
          job.status = 'failed';
          job.error = [401, 403].includes(error.status) ? 'sign_in_required' : error.code || 'install_needs_attention';
          await save();
          await deps.report(job).catch(() => {});
          return;
        }
        // Offline, rate limits, and temporary service errors are retryable.
        await deps.sleep(30_000);
      }
    }
    if (job.status !== 'complete') {
      job.status = 'expired';
      job.error = 'approval_window_expired';
      await save();
      await deps.report(job).catch(() => {});
    }
  } finally {
    release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runSlackJob(process.cwd(), {}, () => {
    if (process.send) {
      process.send({ type: 'slack-worker-ready' });
      process.disconnect();
    }
  }).catch(() => {
    process.exitCode = 1;
  });
}
