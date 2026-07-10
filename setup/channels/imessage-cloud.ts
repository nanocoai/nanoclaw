/**
 * Native iMessage (Photon) flow for setup:auto — the `imessage-cloud` channel.
 *
 * Photon owns the iMessage line and exposes it through a persistent Spectrum
 * connection, so setup does not ask for a local/remote mode, relay URL, API
 * key, webhook, or public endpoint.
 *
 * Flow:
 *   1. Ask for the operator's E.164 iMessage phone number
 *   2. Run Photon device login and auto-provision the project, secret, user,
 *      and iMessage line (scripts/photon-setup.ts)
 *   3. Fetch the imessage-cloud adapter from the channels branch, install the
 *      pinned Spectrum runtime, and build (setup/add-imessage-cloud.sh)
 *   4. Restart NanoClaw so the channel connects
 *   5. Wire the operator's iMessage DM to the first agent
 *
 * All output obeys the three-level contract. See docs/setup-flow.md.
 */
import * as p from '@clack/prompts';
import k from 'kleur';

import { isE164, main as runPhotonSetup, normalizePhone } from '../../scripts/photon-setup.js';
import * as setupLog from '../logs.js';
import type { ChannelFlowResult } from '../lib/back-nav.js';
import { askOperatorRole } from '../lib/role-prompt.js';
import { ensureAnswer, fail, runQuietChild } from '../lib/runner.js';
import { accentGreen, note } from '../lib/theme.js';

const DEFAULT_AGENT_NAME = 'Nano';

export async function runIMessageCloudChannel(displayName: string): Promise<ChannelFlowResult> {
  const phone = await askOperatorPhone();

  let provisionCode: number;
  try {
    provisionCode = await runPhotonSetup(['setup', '--phone', phone, '--embedded']);
  } catch (error) {
    await fail(
      'imessage-cloud-provision',
      "Couldn't reach Photon to finish account setup.",
      error instanceof Error ? error.message : 'Re-run setup to retry.',
    );
  }
  if (provisionCode !== 0) {
    await fail(
      'imessage-cloud-provision',
      "Couldn't finish Photon account setup.",
      'Re-run setup to retry the device login and provisioning flow.',
    );
  }

  // Fetch the adapter from the channels branch, install the pinned Spectrum
  // runtime, and build — mirrors /add-imessage-cloud. Idempotent.
  const install = await runQuietChild('imessage-cloud-install', 'bash', ['setup/add-imessage-cloud.sh'], {
    running: 'Installing the iMessage (Photon) adapter…',
    done: 'iMessage (Photon) adapter installed.',
  });
  if (!install.ok) {
    await fail(
      'imessage-cloud-install',
      "Couldn't install the iMessage (Photon) adapter.",
      'See logs/setup-steps/imessage-cloud-install.log for details, then retry setup.',
      install.rawLog,
    );
  }

  // Re-running the idempotent service step rebuilds dist, reloads the service
  // manager entry, and starts the adapter with its newly written creds.
  const restart = await runQuietChild(
    'imessage-cloud-service',
    'pnpm',
    ['exec', 'tsx', 'setup/index.ts', '--step', 'service'],
    {
      running: 'Restarting NanoClaw with iMessage…',
      done: 'NanoClaw restarted with iMessage.',
    },
  );
  if (!restart.ok) {
    await fail(
      'imessage-cloud-service',
      "Couldn't restart NanoClaw with iMessage.",
      'See logs/setup-steps/imessage-cloud-service.log for details, then retry setup.',
      restart.rawLog,
    );
  }

  const role = await askOperatorRole('iMessage');
  setupLog.userInput('imessage_cloud_role', role);

  const agentName = await resolveAgentName();
  const init = await runQuietChild(
    'init-first-agent',
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/init-first-agent.ts',
      '--channel',
      'imessage-cloud',
      '--user-id',
      `imessage-cloud:${phone}`,
      '--platform-id',
      phone,
      '--display-name',
      displayName,
      '--agent-name',
      agentName,
      '--role',
      role,
    ],
    {
      running: `Connecting ${agentName} to iMessage…`,
      done: `${agentName} is ready. Check iMessage for a welcome message.`,
    },
    {
      extraFields: {
        CHANNEL: 'imessage-cloud',
        AGENT_NAME: agentName,
        PLATFORM_ID: phone,
      },
    },
  );
  if (!init.ok) {
    await fail(
      'init-first-agent',
      `Couldn't finish connecting ${agentName}.`,
      'Check logs/nanoclaw.error.log for connection errors, then retry setup.',
      init.rawLog,
    );
  }
}

async function askOperatorPhone(): Promise<string> {
  note(
    [
      'Photon provides the managed iMessage number for your assistant.',
      'Enter the phone number you use to send iMessages to it.',
      '',
      k.dim('Use international E.164 format: + followed by country code and number.'),
      k.dim('Example: +14155551234'),
    ].join('\n'),
    'Your iMessage phone number',
  );

  const answer = ensureAnswer(
    await p.text({
      message: 'Your iMessage phone number',
      validate: (value) =>
        isE164(normalizePhone(value ?? '')) ? undefined : 'Enter a valid E.164 number, e.g. +15551234567',
    }),
  );
  const phone = normalizePhone(answer as string);
  setupLog.userInput('imessage_cloud_phone', phone);
  return phone;
}

async function resolveAgentName(): Promise<string> {
  const preset = process.env.NANOCLAW_AGENT_NAME?.trim();
  if (preset) {
    setupLog.userInput('agent_name', preset);
    return preset;
  }
  const answer = ensureAnswer(
    await p.text({
      message: `What should your ${accentGreen('assistant')} be called?`,
      placeholder: DEFAULT_AGENT_NAME,
      defaultValue: DEFAULT_AGENT_NAME,
    }),
  );
  const value = (answer as string).trim() || DEFAULT_AGENT_NAME;
  setupLog.userInput('agent_name', value);
  return value;
}
