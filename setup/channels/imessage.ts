/**
 * iMessage channel flow for setup:auto — one channel, two backends.
 *
 * `runIMessageChannel(displayName)` asks which backend to run, then drives it:
 *
 *   Local (macOS): the bot runs on this Mac and talks via the signed-in
 *   iMessage account. Reading chat.db needs Full Disk Access granted to the
 *   Node binary — we open the directory so they can drag the `node` file into
 *   System Settings.
 *
 *   Hosted iMessage (photon.codes): the service owns the iMessage line and exposes it through a
 *   persistent Spectrum connection, so there is no relay URL, API key, webhook,
 *   or public endpoint. A device-login wizard provisions the project, secret,
 *   user, and iMessage line for you.
 *
 * Flow:
 *   1. Pick backend (local on macOS by default; hosted-only off macOS)
 *   2. Local: FDA walkthrough + ask for the phone/email you iMessage from
 *      Hosted: ask for your E.164 number, run Photon device login + provisioning
 *   3. Install the adapter + the chosen backend's package (setup/add-imessage.sh)
 *   4. Restart NanoClaw so the channel connects
 *   5. Wire the operator's iMessage DM to the first agent (--channel imessage)
 *
 * All output obeys the three-level contract. See docs/setup-flow.md.
 */
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { isE164, main as runPhotonSetup, normalizePhone } from '../../scripts/photon-setup.js';
import * as setupLog from '../logs.js';
import { BACK_TO_CHANNEL_SELECTION, type ChannelFlowResult } from '../lib/back-nav.js';
import { brightSelect } from '../lib/bright-select.js';
import { askOperatorRole } from '../lib/role-prompt.js';
import { ensureAnswer, fail, runQuietChild } from '../lib/runner.js';
import { accentGreen, note, wrapForGutter } from '../lib/theme.js';

const DEFAULT_AGENT_NAME = 'Nano';

type Backend = 'local' | 'hosted';

export async function runIMessageChannel(displayName: string): Promise<ChannelFlowResult> {
  const isMac = os.platform() === 'darwin';

  const backend = await askBackend(isMac);
  if (backend === 'back') return BACK_TO_CHANNEL_SELECTION;

  // Backend-specific provisioning + the platform id / user id we wire.
  let installEnv: Record<string, string>;
  let userId: string;
  let platformId: string;

  if (backend === 'local') {
    await walkThroughFullDiskAccess();
    const handle = await askOperatorHandle();
    installEnv = { IMESSAGE_BACKEND: 'local', IMESSAGE_ENABLED: 'true' };
    userId = handle;
    platformId = handle;
  } else {
    const phone = await askOperatorPhone();

    // Photon device login → auto-provisions project/secret/user/line and writes
    // PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET to .env.
    let provisionCode: number;
    try {
      provisionCode = await runPhotonSetup(['setup', '--phone', phone, '--embedded']);
    } catch (error) {
      await fail(
        'imessage-provision',
        "Couldn't reach photon.codes to finish account setup.",
        error instanceof Error ? error.message : 'Re-run setup to retry.',
      );
    }
    if (provisionCode !== 0) {
      await fail(
        'imessage-provision',
        "Couldn't finish the hosted iMessage (photon.codes) account setup.",
        'Re-run setup to retry the device login and provisioning flow.',
      );
    }
    installEnv = { IMESSAGE_BACKEND: 'hosted' };
    userId = `imessage:${phone}`;
    platformId = phone;
  }

  // Fetch the adapter from the channels branch, install the chosen backend's
  // package, and build — mirrors /add-imessage. Idempotent.
  const install = await runQuietChild(
    'imessage-install',
    'bash',
    ['setup/add-imessage.sh'],
    {
      running: 'Installing the iMessage adapter…',
      done: 'iMessage adapter installed.',
    },
    { env: installEnv, extraFields: { BACKEND: backend } },
  );
  if (!install.ok) {
    await fail(
      'imessage-install',
      "Couldn't install the iMessage adapter.",
      'See logs/setup-steps/imessage-install.log for details, then retry setup.',
      install.rawLog,
    );
  }

  // Re-running the idempotent service step rebuilds dist, reloads the service
  // manager entry, and starts the adapter with its newly written creds.
  const restart = await runQuietChild(
    'imessage-service',
    'pnpm',
    ['exec', 'tsx', 'setup/index.ts', '--step', 'service'],
    {
      running: 'Restarting NanoClaw with iMessage…',
      done: 'NanoClaw restarted with iMessage.',
    },
  );
  if (!restart.ok) {
    await fail(
      'imessage-service',
      "Couldn't restart NanoClaw with iMessage.",
      'See logs/setup-steps/imessage-service.log for details, then retry setup.',
      restart.rawLog,
    );
  }

  const role = await askOperatorRole('iMessage');
  setupLog.userInput('imessage_role', role);

  const agentName = await resolveAgentName();

  const init = await runQuietChild(
    'init-first-agent',
    'pnpm',
    [
      'exec', 'tsx', 'scripts/init-first-agent.ts',
      '--channel', 'imessage',
      '--user-id', userId,
      '--platform-id', platformId,
      '--display-name', displayName,
      '--agent-name', agentName,
      '--role', role,
    ],
    {
      running: `Connecting ${agentName} to iMessage…`,
      done: `${agentName} is ready. Check iMessage for a welcome message.`,
    },
    {
      extraFields: {
        CHANNEL: 'imessage',
        AGENT_NAME: agentName,
        PLATFORM_ID: platformId,
        BACKEND: backend,
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

async function askBackend(isMac: boolean): Promise<Backend | 'back'> {
  const baseOptions = isMac
    ? [
        {
          value: 'local' as const,
          label: 'Local (this Mac)',
          hint: "uses this Mac's iMessage account",
        },
        {
          value: 'hosted' as const,
          label: 'Hosted iMessage',
          hint: 'managed line via photon.codes — no Mac needed',
        },
      ]
    : [
        {
          value: 'hosted' as const,
          label: 'Hosted iMessage',
          hint: 'managed line via photon.codes',
        },
      ];
  const choice = ensureAnswer(
    await brightSelect<Backend | 'back'>({
      message: 'How should iMessage run?',
      initialValue: isMac ? 'local' : 'hosted',
      options: [
        ...baseOptions,
        { value: 'back', label: '← Back to channel selection' },
      ],
    }),
  );
  if (choice !== 'back') setupLog.userInput('imessage_backend', String(choice));
  return choice;
}

/**
 * Grant Full Disk Access to the Node binary the host runs under — without it,
 * the local backend can't read chat.db and inbound messages never arrive.
 * Opening the containing directory in Finder makes the drag-and-drop target
 * obvious; falling back to printing the path keeps us working in SSH/headless
 * contexts where `open` is a no-op.
 */
async function walkThroughFullDiskAccess(): Promise<void> {
  let nodePath = process.execPath;
  try {
    // `which node` picks up the user's shell-resolved node, which may differ
    // from process.execPath (e.g. they launched setup under a different
    // Node via `nvm`). If it succeeds and is resolvable, prefer it.
    const which = execSync('which node', { encoding: 'utf-8' }).trim();
    if (which) nodePath = which;
  } catch {
    // fall back to process.execPath
  }
  const nodeDir = path.dirname(nodePath);

  note(
    wrapForGutter(
      [
        `iMessage needs Full Disk Access granted to the Node binary:`,
        '',
        `  ${nodePath}`,
        '',
        '  1. System Settings → Privacy & Security → Full Disk Access',
        `  2. Click +, then drag the "node" file from the Finder window`,
        '     we just opened for you',
        '  3. Toggle it on, then come back here',
      ].join('\n'),
      6,
    ),
    'Grant Full Disk Access',
  );

  try {
    execSync(`open "${nodeDir}"`, { stdio: 'ignore' });
  } catch {
    // No Finder (SSH/headless) — user sees the path in the note above.
  }

  ensureAnswer(
    await p.confirm({
      message: "Granted Full Disk Access?",
      initialValue: true,
    }),
  );
  setupLog.userInput('imessage_fda_confirmed', 'true');
}

async function askOperatorHandle(): Promise<string> {
  note(
    [
      "What phone number or email do you iMessage with?",
      "That's where your assistant will send its welcome message.",
      '',
      k.dim('  • Phone: start with + and your country code, no spaces or dashes'),
      k.dim('    Example: +14155551234 (country code 1, then 4155551234)'),
      k.dim('  • Email: whatever iMessage recognises (Apple ID, iCloud alias, …)'),
    ].join('\n'),
    'Your iMessage handle',
  );

  const answer = ensureAnswer(
    await p.text({
      message: 'Phone number or email',
      validate: (v) => {
        const t = (v ?? '').trim();
        if (!t) return 'Required';
        const isPhone = /^\+\d{8,15}$/.test(t);
        const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
        if (!isPhone && !isEmail) {
          return "Use a +E.164 phone number or an email address";
        }
        return undefined;
      },
    }),
  );
  const handle = (answer as string).trim();
  setupLog.userInput('imessage_handle', handle);
  return handle;
}

async function askOperatorPhone(): Promise<string> {
  note(
    [
      'Your hosted iMessage line (via photon.codes) provides the number for your assistant.',
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
  setupLog.userInput('imessage_phone', phone);
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
