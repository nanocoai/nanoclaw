/**
 * iMessage channel flow for setup:auto.
 *
 * `runIMessageChannel(displayName)` covers both deployment modes:
 *
 *   Local (macOS): the bot runs on this Mac and talks via the signed-in
 *   iMessage account. Reading chat.db needs Full Disk Access granted to
 *   the Node binary — we open the directory for them so they can drag
 *   the `node` file into System Settings.
 *
 *   Remote (Photon API): the bot talks to a separate server (Photon)
 *   that owns an iMessage account on another Mac. Used when this host
 *   is Linux, or when the operator wants to keep their daily-driver
 *   Mac's chat history out of the loop.
 *
 * Flow:
 *   1. Pick mode (auto-defaults to local on macOS, remote elsewhere)
 *   2. Local: FDA walkthrough (open node bin directory, wait for ack)
 *      Remote: prompt for Photon server URL + API key
 *   3. Ask for the phone or email the operator messages from — this is
 *      the platform-id for first-agent wiring
 *   4. Install the adapter (setup/add-imessage.sh, non-interactive)
 *   5. Wire the agent via scripts/init-first-agent.ts — the welcome
 *      iMessage goes out through the normal delivery path
 *
 * All output obeys the three-level contract. See docs/setup-flow.md.
 */
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import * as setupLog from '../logs.js';
import { BACK_TO_CHANNEL_SELECTION, type ChannelFlowResult } from '../lib/back-nav.js';
import { brightSelect } from '../lib/bright-select.js';
import { askOperatorRole } from '../lib/role-prompt.js';
import { ensureAnswer, fail, runQuietChild } from '../lib/runner.js';
import { accentGreen, note, wrapForGutter } from '../lib/theme.js';
import { readEnvKey } from '../environment.js';

const DEFAULT_AGENT_NAME = 'Nano';

type Mode = 'local' | 'remote';

interface RemoteCreds {
  serverUrl: string;
  apiKey: string;
}

export async function runIMessageChannel(displayName: string): Promise<ChannelFlowResult> {
  const isMac = os.platform() === 'darwin';

  const mode = await askMode(isMac);
  if (mode === 'back') return BACK_TO_CHANNEL_SELECTION;
  let remoteCreds: RemoteCreds | null = null;

  if (mode === 'local') {
    if (!isMac) {
      await fail(
        'imessage',
        "Local iMessage mode only works on macOS.",
        'Choose remote mode (Photon API) on Linux/WSL, or run setup from your Mac.',
      );
    }
    await walkThroughFullDiskAccess();
  } else {
    remoteCreds = await collectRemoteCreds();
  }

  const handle = await askOperatorHandle();

  const install = await runQuietChild(
    'imessage-install',
    'bash',
    ['setup/add-imessage.sh'],
    {
      running:
        mode === 'local'
          ? "Connecting the iMessage adapter to this Mac…"
          : `Connecting the iMessage adapter to ${remoteCreds!.serverUrl}…`,
      done: 'iMessage adapter installed.',
    },
    {
      env:
        mode === 'local'
          ? { IMESSAGE_LOCAL: 'true', IMESSAGE_ENABLED: 'true' }
          : {
              IMESSAGE_LOCAL: 'false',
              IMESSAGE_SERVER_URL: remoteCreds!.serverUrl,
              IMESSAGE_API_KEY: remoteCreds!.apiKey,
            },
      extraFields: { MODE: mode },
    },
  );
  if (!install.ok) {
    await fail(
      'imessage-install',
      "Couldn't install the iMessage adapter.",
      'See logs/setup-steps/ for details, then retry setup.',
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
      '--user-id', handle,
      '--platform-id', handle,
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
        PLATFORM_ID: handle,
        MODE: mode,
      },
    },
  );
  if (!init.ok) {
    await fail(
      'init-first-agent',
      `Couldn't finish connecting ${agentName}.`,
      'Double-check Full Disk Access (local mode) or Photon credentials (remote), then retry.',
    );
  }
}

async function askMode(isMac: boolean): Promise<Mode | 'back'> {
  const baseOptions = isMac
    ? [
        {
          value: 'local' as const,
          label: 'Local (this Mac)',
          hint: "uses this machine's iMessage account",
        },
        {
          value: 'remote' as const,
          label: 'Remote (Photon API)',
          hint: 'the bot lives on another server',
        },
      ]
    : [
        {
          value: 'remote' as const,
          label: 'Remote (Photon API)',
          hint: 'only option off macOS',
        },
      ];
  const choice = ensureAnswer(
    await brightSelect<Mode | 'back'>({
      message: 'How should iMessage run?',
      initialValue: isMac ? 'local' : 'remote',
      options: [
        ...baseOptions,
        { value: 'back', label: '← Back to channel selection' },
      ],
    }),
  );
  if (choice !== 'back') setupLog.userInput('imessage_mode', String(choice));
  return choice;
}

/**
 * Grant Full Disk Access to the Node binary the host runs under — without
 * it, the adapter can't read chat.db and inbound messages never arrive.
 * Opening the containing directory in Finder makes the drag-and-drop
 * target obvious; falling back to printing the path keeps us working in
 * SSH/headless contexts where `open` is a no-op.
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

async function collectRemoteCreds(): Promise<RemoteCreds> {
  const existingUrl = readEnvKey('IMESSAGE_SERVER_URL');
  const existingKey = readEnvKey('IMESSAGE_API_KEY');
  if (existingUrl && existingKey && /^https?:\/\//i.test(existingUrl)) {
    const reuse = ensureAnswer(await p.confirm({
      message: `Found existing Photon credentials (${existingUrl}). Use them?`,
      initialValue: true,
    }));
    if (reuse) {
      setupLog.userInput('imessage_remote_creds', 'reused-existing');
      return { serverUrl: existingUrl, apiKey: existingKey };
    }
  }

  note(
    [
      "Photon is a separate service that owns an iMessage account and",
      "exposes it over HTTP. NanoClaw will talk to it via its API.",
      '',
      '  1. Set up a Photon server: https://photon.codes',
      '  2. Copy the server URL and API key from your Photon dashboard',
    ].join('\n'),
    'Remote iMessage via Photon',
  );

  const urlAnswer = ensureAnswer(
    await p.text({
      message: 'Photon server URL',
      placeholder: 'https://photon.example.com',
      validate: (v) => {
        const t = (v ?? '').trim();
        if (!t) return 'URL is required';
        if (!/^https?:\/\//i.test(t)) return 'Must start with http:// or https://';
        return undefined;
      },
    }),
  );
  const serverUrl = (urlAnswer as string).trim();

  const keyAnswer = ensureAnswer(
    await p.password({
      message: 'Photon API key',
      clearOnError: true,
      validate: (v) => ((v ?? '').trim() ? undefined : 'API key is required'),
    }),
  );
  const apiKey = (keyAnswer as string).trim();

  setupLog.userInput('imessage_server_url', serverUrl);
  setupLog.userInput(
    'imessage_api_key',
    `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`,
  );
  return { serverUrl, apiKey };
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
