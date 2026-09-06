import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as p from '@clack/prompts';
import { openUrl } from './lib/browser.js';
import { installCredentialHelper } from './install-cred-helper.js';
import {
  registryAccountPath,
  registryAuthPath,
  readBrokerUrl,
  writeImageSource,
} from './lib/registry-state.js';
import { SetupClient, writePrivate } from './portal-client.mjs';
import type { ProvisioningCore } from './channels/slack-auto.js';

export type PortalStage = 'echo' | 'slack' | 'perks' | 'tavily' | 'dial';
export const portalEnabled = () => true;

// Save into the existing registry/credential-helper contract after the CLI has
// durably received its encrypted credential. Each checkout retains its own
// installation token so a second checkout does not replace its device identity.
export async function savePortalAccount(client: SetupClient): Promise<void> {
  const account = client.local.registryAccount;
  if (!account?.token) throw new Error('Browser sign-in did not return an installation credential.');
  const record = { ...account, api: readBrokerUrl() };
  await writePrivate(registryAccountPath(), record);
  await writePrivate(registryAuthPath(), { version: 1, broker_url: record.api, registry: record.registry || '', token: record.token });
  if (record.registry) {
    const result = installCredentialHelper({ registryHost: record.registry });
    if (!result.onPath) p.log.warn(`Add ${path.dirname(result.helperPath)} to PATH so Docker can authenticate.`);
  }
}

export async function beginPortal(stage: PortalStage, name = 'Nano'): Promise<SetupClient | null> {
  const client = await new SetupClient({
    origin: process.env.NANOCLAW_PORTAL_ORIGIN || 'https://portal.nanoclaw.dev',
    file: path.join(process.cwd(), 'data/community-portal.json'),
    label: `${os.hostname()} · ${path.basename(process.cwd())}`,
    exclusive: true,
  }).initialize();
  try {
    if (!await client.available(stage)) { await client.stop(); return null; }
    if (await client.resumeEnabled(stage, name)) {
      p.log.info(`${stage === 'perks' ? 'Partner perks' : stage[0].toUpperCase() + stage.slice(1)} already enabled. Continuing setup.`);
      return client;
    }
    const labels = { echo: 'Echo’s hardened agent image', slack: 'Slack for your agent', perks: 'partner perks', tavily: 'Tavily web search', dial: 'Dial, a phone number for your agent' };
    const consent = await p.confirm({ message: `Enable ${labels[stage]}? Open the perks dashboard in your browser?`, initialValue: true });
    if (p.isCancel(consent) || !consent) { await client.stop(); p.log.info('Skipped for now. You can enable it later.'); return null; }
    const flow = await client.start(stage, name);
    p.log.info('Activate your perk in the dashboard. Choose Return to terminal when you are done exploring.');
    // Keep the URL unwrapped so headless users can copy it into another browser.
    process.stdout.write(`\n${flow.url}\n\n`);
    openUrl(flow.url);
    return client;
  } catch (error) {
    await client.stop();
    throw error;
  }
}

export async function runImagePortal(): Promise<void> {
  const client = await beginPortal('echo');
  if (!client) { writeImageSource('local'); return; }
  try {
    const result = await client.wait();
    if (result.status !== 'skipped' || client.local.registryAccount) { await savePortalAccount(client); await client.reconcile(); }
    writeImageSource(result.choice.imageSource || 'local');
    if (result.status !== 'skipped') await client.complete();
    p.log.success('Image choice saved. Continuing setup.');
  } finally {
    await client.stop();
  }
}

export async function runSlackPortal(
  core: ProvisioningCore,
  name: string,
  clientVersion?: string,
): Promise<Record<string, string>> {
  const client = await beginPortal('slack', name);
  if (!client) return { __portal_skip: 'slack' };
  try {
    const setup = await client.wait(),
      choice = setup.choice;
    if (setup.status !== 'skipped' || client.local.registryAccount) { await savePortalAccount(client); await client.reconcile(); }
    if (setup.status === 'skipped') return { __portal_skip: 'slack' };
    const token = client.token;
    const workspace = (await core.brokerListWorkspaces(token)).find(
      (w) => w.team_id === choice.workspaceId && w.status === 'active',
    );
    if (!workspace) throw new Error('The selected workspace is no longer connected. Reconnect it in the portal.');
    let saved = client.local.slackSetup;
    if (saved?.status === 'complete' && saved.workspaceId === choice.workspaceId && saved.name === choice.name && saved.app?.botToken && saved.app?.appToken) {
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
      p.log.info('Finish the app installation approval in the portal. Waiting for Slack…');
      if (!core.waitForInstall || !core.brokerAppStatus)
        throw new Error('Update the Slack channel to support browser approval completion.');
      const result = await core.waitForInstall(token, app.appId, { timeoutMs: 25 * 60_000 });
      if (!result?.botToken)
        throw new Error('Slack approval is still pending. The saved app credentials are available for resuming setup.');
      app.botToken = result.botToken;
      await client.save();
    }
    const inputs: Record<string, string> = {
      connection: 'provisioned',
      bot_token: app.botToken,
      app_token: app.appToken,
    };
    if (workspace.connected_as && /^[UW][A-Z0-9]{8,}$/.test(workspace.connected_as))
      inputs.owner_handle = workspace.connected_as;
    saved.status = 'complete';
    await client.save();
    await client.complete('complete', { appId: app.appId });
    return inputs;
  } finally {
    await client.stop();
  }
}

export async function runPerksPortal(stage: PortalStage = 'perks'): Promise<void> {
  const stages: PortalStage[] = stage === 'perks' ? ['tavily', 'dial'] : [stage];
  for (const perk of stages) {
    const client = await beginPortal(perk);
    if (!client) continue;
    try {
      const result = await client.wait();
      if (result.status !== 'skipped' || client.local.registryAccount) { await savePortalAccount(client); await client.reconcile(); }
      if (result.status !== 'skipped') await client.complete();
      p.log.success(`${perk} setup ${result.status === 'skipped' ? 'skipped for now' : 'complete'}.`);
    } finally { await client.stop(); }
  }
}

export async function run(args: string[]): Promise<void> {
  const i = args.indexOf('--stage'),
    stage = i >= 0 ? args[i + 1] : 'perks';
  if (stage === 'echo') return runImagePortal();
  if (stage === 'perks' || stage === 'tavily' || stage === 'dial') return runPerksPortal(stage);
  if (stage === 'slack') {
    const { runChannelSkillWithPreStep } = await import('./channels/run-channel-skill.js');
    process.env.NANOCLAW_PORTAL_ORIGIN ||= 'https://portal.nanoclaw.dev';
    await runChannelSkillWithPreStep('slack', process.env.NANOCLAW_DISPLAY_NAME || os.userInfo().username);
    return;
  }
  throw new Error('Choose --stage echo, slack, tavily, dial, or perks.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : 'Browser setup failed.');
    process.exitCode = 1;
  });
}
