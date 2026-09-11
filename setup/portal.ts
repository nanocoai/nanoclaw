import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as p from '@clack/prompts';
import { openUrl } from './lib/browser.js';
import { readImageSource, readRegistryAccount, writeImageSource } from './lib/registry-state.js';
import { LoginError, finishDeviceFlow, startDeviceFlow, type DeviceFlow } from './registry-login.js';
import {
  SetupClient,
  ensureDeviceKey,
  errorCode,
  errorStatus,
  readInstallIdentity,
  type DeviceKey,
  type InstallIdentity,
} from '../src/community-portal/index.js';
import type { ProvisioningCore } from './channels/slack-auto.js';
import { readSlackJob } from '../src/community-portal/slack-job.js';

/**
 * The wizard's browser handoffs to the community portal. An enrolled machine
 * makes sure it has its device key and is registered, then starts the stage,
 * opens its link and waits for the browser. A machine without an account gets
 * one browser visit for everything: the registry's device flow (WorkOS, RFC
 * 8628) is started here but its page is not opened; the flow starts
 * anonymously at the portal carrying the user code, the single portal link is
 * printed and opened, and once the sign-in lands the machine registers,
 * claims the flow and waits as usual. Sign-in writes account.json through the
 * sign-in driver's own persist step; nothing here saves credentials.
 */
export type PortalStage = 'echo' | 'slack';
export const portalEnabled = () => true;
const REGISTRY_STEP = 'pnpm exec tsx setup/index.ts --step registry';

async function portalIdentity(): Promise<{ identity: InstallIdentity; deviceKey: DeviceKey }> {
  const identity = await readInstallIdentity();
  if (!identity)
    throw new Error(`The NanoClaw sign-in record is incomplete. Run \`${REGISTRY_STEP}\` to sign in again.`);
  return { identity, deviceKey: ensureDeviceKey() };
}

function portalClient(options: { identity?: InstallIdentity; deviceKey?: DeviceKey } = {}): SetupClient {
  return new SetupClient({
    origin: process.env.NANOCLAW_PORTAL_ORIGIN || 'https://portal.nanoclaw.dev',
    file: path.join(process.cwd(), 'data/community-portal.json'),
    label: `${os.hostname()} · ${path.basename(process.cwd())}`,
    exclusive: true,
    waitForLockMs: 30_000,
    autoContinue: true,
    ...options,
  });
}

/**
 * Register (or re-affirm) this machine at the portal. Idempotent; the device
 * id is cached in the journal. False, after saying why, when the portal
 * refuses: a sign-in it no longer accepts, a device pinned to another key, or
 * the account's device limit. Anything else is an ordinary failure.
 */
async function registerDevice(client: SetupClient): Promise<boolean> {
  try {
    await client.register();
    return true;
  } catch (error) {
    const status = errorStatus(error);
    if (status === 401 || status === 403) {
      p.log.warn(
        `Your NanoClaw sign-in is no longer valid here. Run \`${REGISTRY_STEP}\` to sign in again, then retry this step.`,
      );
      return false;
    }
    if (status === 409) {
      p.log.warn(
        errorCode(error) === 'device_limit'
          ? 'This account already has its maximum number of devices. Forget one in the portal, then retry this step.'
          : 'This machine is registered under a different device key. Forget the device in the portal, then retry this step.',
      );
      return false;
    }
    throw error;
  }
}

/** A sign-in that did not happen is a skipped stage, worded as the sign-in driver words it. */
function skippedSignIn(error: unknown): void {
  if (!(error instanceof LoginError)) throw error;
  p.log.warn([error.message, error.hint, 'Skipping this step for now.'].filter(Boolean).join(' '));
}

/**
 * The not-enrolled path: start the device flow without opening its page,
 * start the stage anonymously with the user code, print and open the single
 * portal link (plus the code and the provider's page on their own lines for
 * headless users), wait for the sign-in, persist it, then register and claim.
 * Declined, expired or failed → null; the stage is skipped and nothing else
 * happens.
 */
async function signInThroughPortal(client: SetupClient, stage: PortalStage, name: string): Promise<boolean> {
  let flow: DeviceFlow;
  try {
    flow = await startDeviceFlow();
  } catch (error) {
    skippedSignIn(error);
    return false;
  }
  const verificationUri = flow.device.verificationUriComplete ?? flow.device.verificationUri;
  const setup = await client.start(stage, name, { verification: { userCode: flow.device.userCode, verificationUri } });
  p.log.info(
    'Open the link below to sign in and approve this terminal. Setup continues automatically as soon as your perk is enabled.',
  );
  // Keep the URL unwrapped so it stays clickable and copyable. The code and
  // the sign-in page are only for a machine without a browser: the portal page
  // opens that sign-in itself.
  process.stdout.write(`\n${setup.url}\n\n`);
  process.stdout.write(
    `No browser on this machine? Sign in from another device instead:\nCode: ${flow.device.userCode}\n${verificationUri}\n\n`,
  );
  openUrl(setup.url);
  try {
    await finishDeviceFlow(flow);
  } catch (error) {
    skippedSignIn(error);
    return false;
  }
  const { identity, deviceKey } = await portalIdentity();
  client.identity = identity;
  client.deviceKey = deviceKey;
  if (!(await registerDevice(client))) return false;
  await client.claim();
  return true;
}

/** One later offer per perk per checkout. Explicit setup commands still work. */
export async function offerPortalReminder(stage: 'echo' | 'slack', enable: () => Promise<void>): Promise<boolean> {
  const identity = await readInstallIdentity();
  const client = await portalClient({ identity: identity ?? undefined }).initialize();
  let consent = false;
  try {
    if (client.local.reminders?.[stage]) return false;
    // A pending, completed, or failed install already has a recovery path. A
    // reminder must never create another app or replace an existing channel.
    if (stage === 'slack' && ((await readSlackJob()) || client.local.slackSetup)) return false;
    const resuming = client.local.reminderPending?.[stage] === true;
    try {
      if (!(await client.available(stage))) return false;
      if (client.token && !resuming) {
        try {
          const state = await client.request('GET', '/api/v1/device/state');
          if (state.activations?.[stage]?.enabled) return false;
        } catch (error: any) {
          // Not signed in here, or not registered yet: the offer still stands.
          if (![401, 403].includes(error.status)) throw error;
        }
      }
    } catch {
      p.log.warn('Could not check optional perks right now. You can enable them from the portal setup step later.');
      return false;
    }
    const answer =
      resuming ||
      (await p.confirm({
        message:
          stage === 'echo'
            ? 'Before starting NanoClaw, enable Echo’s hardened image? Open the perks dashboard?'
            : 'Before you finish, enable Slack for your agent too? Open the perks dashboard?',
        initialValue: false,
      }));
    consent = answer === true;
    if (!consent) {
      client.local.reminders = { ...client.local.reminders, [stage]: true };
    } else {
      // Keep the accepted choice through a failed download/installation so a
      // retry finishes it even though the account perk is already activated.
      client.local.reminderPending = { ...client.local.reminderPending, [stage]: true };
    }
    await client.save();
  } finally {
    await client.stop();
  }
  if (!consent) return false;
  // The regular flow takes its own journal lock. Browser consent applies to
  // this one handoff only; the normal name/role and activation choices remain.
  await enable();
  const latest = await portalClient().initialize();
  try {
    latest.local.reminders = { ...latest.local.reminders, [stage]: true };
    if (latest.local.reminderPending) delete latest.local.reminderPending[stage];
    await latest.save();
  } finally {
    await latest.stop();
  }
  return true;
}

export async function beginPortal(
  stage: PortalStage,
  name = 'Nano',
  { browserConsent = false } = {},
): Promise<SetupClient | null> {
  const enrolled = Boolean(readRegistryAccount());
  const client = await portalClient(enrolled ? await portalIdentity() : {}).initialize();
  const skip = async (): Promise<null> => {
    await client.stop();
    return null;
  };
  try {
    if (enrolled && !(await registerDevice(client))) return await skip();
    if (stage === 'slack') {
      const job = await readSlackJob();
      if (job?.status === 'complete' && job.app.appId === client.local.slackSetup?.app?.appId) {
        client.local.slackSetup.status = 'complete';
        client.local.slackSetup.app = job.app;
        await client.save();
      }
    }
    if (!(await client.available(stage))) return await skip();
    if (
      enrolled &&
      (stage !== 'slack' || client.local.slackSetup?.status === 'complete') &&
      (await client.resumeEnabled(stage, name))
    ) {
      p.log.info(`${stage[0].toUpperCase() + stage.slice(1)} already enabled. Continuing setup.`);
      return client;
    }
    const labels = { echo: 'Echo’s hardened agent image', slack: 'Slack for your agent' };
    const consent =
      browserConsent ||
      (await p.confirm({
        message: `Enable ${labels[stage]}? Open the perks dashboard in your browser?`,
        initialValue: true,
      }));
    if (p.isCancel(consent) || !consent) {
      p.log.info('Skipped for now. You can enable it later.');
      return await skip();
    }
    if (!enrolled) return (await signInThroughPortal(client, stage, name)) ? client : await skip();
    const flow = await client.start(stage, name);
    p.log.info('Activate your perk in the dashboard. Setup continues automatically as soon as it is enabled.');
    // Keep the URL unwrapped so headless users can copy it into another browser.
    process.stdout.write(`\n${flow.url}\n\n`);
    openUrl(flow.url);
    return client;
  } catch (error) {
    await client.stop();
    throw error;
  }
}

export async function runImagePortal(
  options: { browserConsent?: boolean; apply?: () => Promise<void> } = {},
): Promise<void> {
  const previous = readImageSource();
  const client = await beginPortal('echo', 'Nano', options);
  if (!client) {
    if (!options.apply) writeImageSource('local');
    return;
  }
  try {
    const result = await client.wait();
    await client.reconcile();
    if (result.status === 'skipped' && options.apply) return;
    writeImageSource(result.choice.imageSource || 'local');
    if (result.status !== 'skipped') {
      try {
        await options.apply?.();
      } catch (error) {
        writeImageSource(previous);
        await client.complete('failed').catch(() => {});
        throw error;
      }
      await client.complete();
    }
    p.log.success('Image choice saved. Continuing setup.');
  } finally {
    await client.stop();
  }
}

export async function runSlackPortal(
  core: ProvisioningCore,
  name: string,
  clientVersion?: string,
  options: { browserConsent?: boolean } = {},
): Promise<Record<string, string>> {
  const client = await beginPortal('slack', name, options);
  if (!client) return { __portal_skip: 'slack' };
  try {
    const setup = await client.wait(),
      choice = setup.choice;
    await client.reconcile();
    if (setup.status === 'skipped') return { __portal_skip: 'slack' };
    const token = client.token;
    if (!token) throw new Error('Sign in to NanoClaw before setting up Slack.');
    const workspace = (await core.brokerListWorkspaces(token)).find(
      (w) => w.team_id === choice.workspaceId && w.status === 'active',
    );
    if (!workspace) throw new Error('The selected workspace is no longer connected. Reconnect it in the portal.');
    let saved = client.local.slackSetup;
    if (
      saved?.status === 'complete' &&
      saved.workspaceId === choice.workspaceId &&
      saved.name === choice.name &&
      saved.app?.botToken &&
      saved.app?.appToken
    ) {
      if (!core.brokerAppStatus) throw new Error('Update the Slack channel to verify the existing agent.');
      const current = await core.brokerAppStatus(token, saved.app.appId);
      if (current.status === 'installed') saved.setupId = setup.id;
    }
    // Slack create has no idempotency contract. Persist before calling it; a
    // restart must never silently create a second app after an ambiguous result.
    if (saved?.status === 'creating')
      throw new Error(
        'A previous Slack create may have finished. Review the agent list in the portal before recovering this setup.',
      );
    if (
      saved?.setupId !== setup.id &&
      !(saved?.status === 'received' && saved.workspaceId === choice.workspaceId && saved.name === choice.name)
    ) {
      saved = client.local.slackSetup = {
        setupId: setup.id,
        workspaceId: choice.workspaceId,
        name: choice.name,
        status: 'creating',
        serviceBase: core.readServiceBase?.() || 'https://slack.nanoclaw.dev',
      };
      await client.save();
      try {
        saved.app = await core.brokerProvision(token, {
          team_id: choice.workspaceId,
          name: choice.name,
          ...(workspace.connected_as ? { requested_by: workspace.connected_as } : {}),
          ...(clientVersion ? { client_version: clientVersion } : {}),
        });
        saved.status = 'received';
        await client.save();
      } catch (error) {
        await client.complete('failed').catch(() => {});
        throw error;
      }
    }
    const app = saved.app;
    if (!app.botToken) {
      await client.complete('awaiting_approval', { appId: app.appId });
      p.log.info(
        'Continue with the workspace installation in the portal. Slack approval will finish in the background.',
      );
    }

    const inputs: Record<string, string> = {
      connection: 'provisioned',
      ...(app.botToken ? { bot_token: app.botToken } : {}),
      __portal_pending: 'slack',
      app_token: app.appToken,
    };
    if (workspace.connected_as && /^[UW][A-Z0-9]{8,}$/.test(workspace.connected_as))
      inputs.owner_handle = workspace.connected_as;
    await client.save();
    return inputs;
  } finally {
    await client.stop();
  }
}

export async function run(args: string[]): Promise<void> {
  const i = args.indexOf('--stage'),
    stage = i >= 0 ? args[i + 1] : undefined;
  if (stage === 'echo') return runImagePortal();
  if (stage === 'slack') {
    const { runChannelSkillWithPreStep } = await import('./channels/run-channel-skill.js');
    process.env.NANOCLAW_PORTAL_ORIGIN ||= 'https://portal.nanoclaw.dev';
    await runChannelSkillWithPreStep('slack', process.env.NANOCLAW_DISPLAY_NAME || os.userInfo().username);
    return;
  }
  throw new Error('Choose --stage echo or slack.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : 'Browser setup failed.');
    process.exitCode = 1;
  });
}
