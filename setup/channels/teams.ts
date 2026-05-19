/**
 * Microsoft Teams channel flow for setup:auto.
 *
 * Teams is the most complex channel NanoClaw supports — the Slack/Discord
 * "paste a token" shortcut doesn't exist. The operator has to walk through
 * ~7 Azure portal steps (app registration, client secret, Azure Bot
 * resource, messaging endpoint, Teams channel enable, manifest, sideload).
 *
 * This driver's job is to make each of those steps as guided as possible
 * inside the terminal:
 *   1. Print a clack note with the exact sub-steps and the portal URL.
 *   2. Ask for the value(s) that step yields (App ID, secret, tenant, etc.).
 *   3. At every step boundary, offer `stepGate` — a Done / Stuck / Show-again
 *      select. "Stuck" hands off to the configured AI-coding CLI with full
 *      context.
 *
 * Text/password prompts also accept `?` as an answer to trigger the handoff,
 * so the operator can escape at any paste point without scrolling back to a
 * step boundary.
 *
 * What's deferred (known limitation, instruct user how to finish manually):
 *   - Wait-for-first-DM to capture the auto-generated Teams platformId.
 *     Unlike Discord/Telegram, the Teams platform_id is only discoverable
 *     after the first inbound activity. The driver installs the adapter and
 *     stops there; the operator DMs the bot, NanoClaw auto-creates the
 *     messaging group, and they wire an agent via `/manage-channels`.
 */
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { BACK_TO_CHANNEL_SELECTION, type ChannelFlowResult } from '../lib/back-nav.js';
import { brightSelect } from '../lib/bright-select.js';
import { confirmThenOpen } from '../lib/browser.js';
import {
  isHelpEscape,
  offerAiCodingCliHandoff,
  validateWithHelpEscape,
  type HandoffContext,
} from '../lib/cli-handoff.js';
import { ensureAnswer, fail, runQuietChild } from '../lib/runner.js';
import { buildTeamsAppPackage } from '../lib/teams-manifest.js';
import { note } from '../lib/theme.js';
import * as setupLog from '../logs.js';
import { readEnvKey } from '../environment.js';

const CHANNEL = 'teams';
const MANIFEST_DIR = path.join(process.cwd(), 'data', 'teams');
const AZURE_PORTAL_URL = 'https://portal.azure.com';

interface Collected {
  publicUrl?: string;
  appId?: string;
  tenantId?: string;
  appType?: 'SingleTenant' | 'MultiTenant';
  appPassword?: string;
  agentName?: string;
}

export async function runTeamsChannel(_displayName: string): Promise<ChannelFlowResult> {
  const collected: Collected = {};
  const completed: string[] = [];

  const existingAppId = readEnvKey('TEAMS_APP_ID');
  const existingPassword = readEnvKey('TEAMS_APP_PASSWORD');
  if (existingAppId && existingPassword) {
    const choice = ensureAnswer(await brightSelect<'yes' | 'no' | 'back'>({
      message: `Found existing Teams credentials (App ID: ${existingAppId.slice(0, 8)}…). Use them?`,
      options: [
        { value: 'yes', label: 'Yes, use the existing credentials' },
        { value: 'no', label: "No, set up new ones" },
        { value: 'back', label: '← Back to channel selection' },
      ],
      initialValue: 'yes',
    }));
    if (choice === 'back') return BACK_TO_CHANNEL_SELECTION;
    if (choice === 'yes') {
      collected.appId = existingAppId;
      collected.appPassword = existingPassword;
      collected.appType = (readEnvKey('TEAMS_APP_TYPE') as 'SingleTenant' | 'MultiTenant') || 'MultiTenant';
      if (collected.appType === 'SingleTenant') {
        collected.tenantId = readEnvKey('TEAMS_APP_TENANT_ID') ?? undefined;
      }
      setupLog.userInput('teams_credentials', 'reused-existing');
      await installAdapter(collected);
      completed.push('Adapter installed and service restarted (reused existing credentials).');
      await finishWithHandoff(collected, completed);
      return;
    }
  }

  printIntro();

  const prereqsResult = await confirmPrereqs({ collected, completed });
  if (prereqsResult === 'back') return BACK_TO_CHANNEL_SELECTION;
  await stepPublicUrl({ collected, completed });
  if (await stepAppRegistration({ collected, completed }) === 'back') {
    return BACK_TO_CHANNEL_SELECTION;
  }
  if (await stepClientSecret({ collected, completed }) === 'back') {
    return BACK_TO_CHANNEL_SELECTION;
  }
  if (await stepAzureBot({ collected, completed }) === 'back') {
    return BACK_TO_CHANNEL_SELECTION;
  }
  if (await stepEnableTeamsChannel({ collected, completed }) === 'back') {
    return BACK_TO_CHANNEL_SELECTION;
  }
  const manifestResult = await stepGenerateManifest({ collected, completed });
  if (
    await stepSideload({ collected, completed, zipPath: manifestResult.zipPath })
    === 'back'
  ) {
    return BACK_TO_CHANNEL_SELECTION;
  }

  await installAdapter(collected);
  completed.push('Adapter installed and service restarted.');

  await finishWithHandoff(collected, completed);
}

// ─── step: intro / prereqs ──────────────────────────────────────────────

function printIntro(): void {
  note(
    [
      'Setting up Teams is more involved than the other channels — about',
      '7 steps across the Azure portal and Teams admin.',
      '',
      k.dim("At any prompt you can type '?' and press Enter to hand off"),
      k.dim("to your AI-coding CLI in interactive mode with your current progress."),
      k.dim("You can also pick 'Stuck' at any Done/Stuck/Show-again prompt."),
    ].join('\n'),
    'Microsoft Teams setup',
  );
}

async function confirmPrereqs(args: { collected: Collected; completed: string[] }): Promise<'continue' | 'back'> {
  note(
    [
      'Before we start, confirm you have:',
      '',
      '  • A Microsoft 365 tenant where you can sideload custom apps',
      '    (free personal Teams does NOT support this — you need a',
      '     Microsoft 365 Business / EDU / developer tenant)',
      '  • Teams admin or developer tenant rights',
      '  • A way to expose an HTTPS endpoint from this machine',
      '    (ngrok, Cloudflare Tunnel, or a reverse-proxied VPS)',
    ].join('\n'),
    'Prereqs',
  );

  // Back-aware variant of stepGate — Back is only offered on the very first
  // step of the Teams flow so users can bail out before any state is taken.
  while (true) {
    const choice = ensureAnswer(
      await brightSelect<'done' | 'help' | 'reshow' | 'back'>({
        message: 'How did that go?',
        options: [
          { value: 'done', label: "Done — let's continue" },
          { value: 'help', label: 'Stuck — hand me off for help' },
          { value: 'reshow', label: 'Show me the steps again' },
          { value: 'back', label: '← Back to channel selection' },
        ],
      }),
    );
    if (choice === 'back') return 'back';
    if (choice === 'done') break;
    if (choice === 'help') {
      await offerHandoff({
        step: 'teams-prereqs',
        stepDescription: 'confirming they have the right Microsoft 365 tenant and tunnel',
        args,
      });
      continue;
    }
    if (choice === 'reshow') {
      return confirmPrereqs(args);
    }
  }
  args.completed.push('Prereqs confirmed.');
  return 'continue';
}

// ─── step: public URL ──────────────────────────────────────────────────

async function stepPublicUrl(args: { collected: Collected; completed: string[] }): Promise<void> {
  note(
    [
      "Azure Bot Service delivers messages to an HTTPS endpoint you",
      "control. The endpoint needs to reach this machine's webhook",
      "server at /api/webhooks/teams.",
      '',
      k.dim('Examples:'),
      k.dim('  ngrok http 3000      → https://abcd1234.ngrok.io'),
      k.dim('  cloudflared tunnel …  → https://<tunnel>.trycloudflare.com'),
      k.dim('  or a reverse proxy on your own domain'),
      '',
      "If you don't have a tunnel running yet, start one in another",
      "terminal, then come back here.",
    ].join('\n'),
    'Public HTTPS URL',
  );

  while (true) {
    const answer = ensureAnswer(
      await p.text({
        message: 'Paste your public base URL (e.g. https://abcd1234.ngrok.io)',
        placeholder: 'https://…',
        validate: validateWithHelpEscape((v) => {
          const t = (v ?? '').trim();
          if (!t) return 'Required';
          if (!/^https:\/\/[^\s/]+/.test(t)) {
            return 'Must be an https:// URL (Azure rejects http)';
          }
          return undefined;
        }),
      }),
    );
    if (isHelpEscape(answer)) {
      await offerHandoff({
        step: 'teams-public-url',
        stepDescription:
          'setting up a public HTTPS tunnel to reach this machine on port 3000',
        args,
      });
      continue;
    }
    const url = (answer as string).trim().replace(/\/$/, '');
    args.collected.publicUrl = url;
    setupLog.userInput('teams_public_url', url);
    break;
  }

  args.completed.push(`Public URL: ${args.collected.publicUrl}`);
}

// ─── step: Azure App Registration ──────────────────────────────────────

async function stepAppRegistration(args: {
  collected: Collected;
  completed: string[];
}): Promise<'continue' | 'back'> {
  note(
    [
      `1. In ${AZURE_PORTAL_URL}, search "App registrations" → "New registration"`,
      '2. Name it (e.g. "NanoClaw")',
      '3. Supported account types: Single tenant (your org only) OR',
      '   Multi tenant (any Microsoft 365 tenant can add the bot)',
      '4. Click Register',
      '5. On the Overview page, copy:',
      '     • Application (client) ID',
      '     • Directory (tenant) ID',
    ].join('\n'),
    'Step 1 of 6 — Create Azure App Registration',
  );
  await confirmThenOpen(
    AZURE_PORTAL_URL,
    'Press Enter to open the Azure portal',
  );

  args.collected.appType = await askAppType(args);
  args.collected.appId = await askUuid(
    'Paste the Application (client) ID',
    'teams-app-id',
    args,
  );
  if (args.collected.appType === 'SingleTenant') {
    args.collected.tenantId = await askUuid(
      'Paste the Directory (tenant) ID',
      'teams-tenant-id',
      args,
    );
  }

  const gate = await stepGate({
    stepName: 'teams-app-registration',
    stepDescription: 'registering an app in Azure and collecting App ID + tenant type',
    reshow: () => stepAppRegistration(args),
    args,
  });
  if (gate === 'back') return 'back';
  args.completed.push(
    `App registered: ${args.collected.appId} (${args.collected.appType})`,
  );
  return 'continue';
}

async function askAppType(args: {
  collected: Collected;
  completed: string[];
}): Promise<'SingleTenant' | 'MultiTenant'> {
  while (true) {
    const choice = ensureAnswer(
      await brightSelect({
        message: 'Which account type did you pick?',
        options: [
          {
            value: 'SingleTenant',
            label: 'Single tenant',
            hint: 'your org only — most common for self-host',
          },
          {
            value: 'MultiTenant',
            label: 'Multi tenant',
            hint: 'any Microsoft 365 tenant can install the bot',
          },
          { value: 'help', label: 'Stuck — hand me off for help' },
        ],
      }),
    );
    if (choice === 'help') {
      await offerHandoff({
        step: 'teams-app-type',
        stepDescription: "deciding between Single tenant and Multi tenant for their Azure app",
        args,
      });
      continue;
    }
    return choice as 'SingleTenant' | 'MultiTenant';
  }
}

// ─── step: client secret ───────────────────────────────────────────────

async function stepClientSecret(args: {
  collected: Collected;
  completed: string[];
}): Promise<'continue' | 'back'> {
  note(
    [
      `1. In your app registration, open "Certificates & secrets"`,
      '2. Click "New client secret"',
      '     Description: nanoclaw',
      '     Expires: 180 days (recommended) or longer',
      '3. Click Add',
      '4. ' + k.yellow('COPY THE VALUE NOW — Azure only shows it once'),
      '   (the Value column, not the Secret ID)',
    ].join('\n'),
    'Step 2 of 6 — Create a client secret',
  );

  while (true) {
    const answer = ensureAnswer(
      await p.password({
        message: 'Paste the client secret Value',
        clearOnError: true,
        validate: validateWithHelpEscape((v) => {
          const t = (v ?? '').trim();
          if (!t) return 'Required';
          if (t.length < 20) return "That looks too short — make sure you copied the Value, not the Secret ID";
          return undefined;
        }),
      }),
    );
    if (isHelpEscape(answer)) {
      await offerHandoff({
        step: 'teams-client-secret',
        stepDescription: 'creating and copying the client secret value from Azure',
        args,
      });
      continue;
    }
    args.collected.appPassword = (answer as string).trim();
    setupLog.userInput(
      'teams_client_secret',
      `${args.collected.appPassword.slice(0, 4)}…${args.collected.appPassword.slice(-4)}`,
    );
    break;
  }

  const gate = await stepGate({
    stepName: 'teams-client-secret',
    stepDescription: 'creating and copying the client secret',
    reshow: () => stepClientSecret(args),
    args,
  });
  if (gate === 'back') return 'back';
  args.completed.push('Client secret captured.');
  return 'continue';
}

// ─── step: Azure Bot resource ──────────────────────────────────────────

async function stepAzureBot(args: {
  collected: Collected;
  completed: string[];
}): Promise<'continue' | 'back'> {
  const endpoint = `${args.collected.publicUrl}/api/webhooks/teams`;
  const tenantFlag =
    args.collected.appType === 'SingleTenant'
      ? `--tenant-id ${args.collected.tenantId} `
      : '';
  const cliCommand =
    `az bot create \\\n` +
    `  --resource-group nanoclaw-rg \\\n` +
    `  --name nanoclaw-bot \\\n` +
    `  --app-type ${args.collected.appType} \\\n` +
    `  --appid ${args.collected.appId} \\\n` +
    `  ${tenantFlag}--endpoint "${endpoint}"`;

  note(
    [
      `In ${AZURE_PORTAL_URL}, search "Azure Bot" → Create.`,
      '',
      '  • Bot handle: unique name, e.g. nanoclaw-bot',
      `  • Type of App: ${args.collected.appType}`,
      '  • Creation type: Use existing app registration',
      `  • App ID: ${args.collected.appId ?? '<pending>'}`,
      ...(args.collected.appType === 'SingleTenant'
        ? [`  • App tenant ID: ${args.collected.tenantId ?? '<pending>'}`]
        : []),
      '',
      'After creating, open the bot → Configuration and set:',
      `  Messaging endpoint: ${k.cyan(endpoint)}`,
      '',
      k.dim('Or via Azure CLI (if you have az installed):'),
      k.dim(cliCommand),
    ].join('\n'),
    'Step 3 of 6 — Create Azure Bot resource',
  );

  const gate = await stepGate({
    stepName: 'teams-azure-bot',
    stepDescription:
      'creating an Azure Bot resource linked to the app registration and setting the messaging endpoint',
    reshow: () => stepAzureBot(args),
    args,
  });
  if (gate === 'back') return 'back';
  args.completed.push('Azure Bot created; messaging endpoint configured.');
  return 'continue';
}

// ─── step: enable Teams channel ────────────────────────────────────────

async function stepEnableTeamsChannel(args: {
  collected: Collected;
  completed: string[];
}): Promise<'continue' | 'back'> {
  note(
    [
      '1. Open your Azure Bot resource → Channels',
      '2. Click Microsoft Teams → Accept terms → Apply',
      '',
      k.dim('CLI alternative:'),
      k.dim('  az bot msteams create --resource-group nanoclaw-rg --name nanoclaw-bot'),
    ].join('\n'),
    'Step 4 of 6 — Enable Teams channel on the bot',
  );
  const gate = await stepGate({
    stepName: 'teams-enable-channel',
    stepDescription: 'enabling the Microsoft Teams channel on the Azure Bot resource',
    reshow: () => stepEnableTeamsChannel(args),
    args,
  });
  if (gate === 'back') return 'back';
  args.completed.push('Teams channel enabled on the bot.');
  return 'continue';
}

// ─── step: manifest zip ────────────────────────────────────────────────

async function stepGenerateManifest(args: {
  collected: Collected;
  completed: string[];
}): Promise<{ zipPath: string }> {
  if (!args.collected.appId) {
    fail(
      'teams-manifest',
      'Missing Azure App ID.',
      "That's an internal bug — open an issue or retry setup.",
    );
  }
  const shortName =
    process.env.NANOCLAW_AGENT_NAME?.trim() || 'NanoClaw';

  const s = p.spinner();
  s.start('Generating your Teams app package…');
  try {
    const result = buildTeamsAppPackage({
      appId: args.collected.appId!,
      shortName,
      longDescription: `${shortName} personal assistant powered by NanoClaw.`,
      websiteUrl: args.collected.publicUrl!,
      outDir: MANIFEST_DIR,
    });
    s.stop(`Package ready: ${k.cyan(shortPath(result.zipPath))}`);
    setupLog.step('teams-manifest', 'success', 0, {
      ZIP: result.zipPath,
    });
    args.completed.push(`Generated manifest zip at ${shortPath(result.zipPath)}.`);
    return { zipPath: result.zipPath };
  } catch (err) {
    s.stop("Couldn't build the manifest zip.", 1);
    const message = err instanceof Error ? err.message : String(err);
    setupLog.step('teams-manifest', 'failed', 0, { ERROR: message });
    fail(
      'teams-manifest',
      "Couldn't generate the Teams app package.",
      'Make sure `zip` is available on your PATH, then retry.',
    );
  }
}

// ─── step: sideload ────────────────────────────────────────────────────

async function stepSideload(args: {
  collected: Collected;
  completed: string[];
  zipPath: string;
}): Promise<'continue' | 'back'> {
  note(
    [
      '1. Open Microsoft Teams',
      '2. Go to Apps → Manage your apps → Upload an app',
      '3. Click "Upload a custom app" (or "Upload for me or my teams")',
      `4. Select: ${k.cyan(args.zipPath)}`,
      '5. Click Add',
      '',
      k.dim('If "Upload a custom app" is missing, your tenant admin has'),
      k.dim('disabled sideloading. Enable it in Teams Admin Center →'),
      k.dim('Teams apps → Setup policies → Global → Upload custom apps = On'),
    ].join('\n'),
    'Step 5 of 6 — Sideload the app into Teams',
  );
  const gate = await stepGate({
    stepName: 'teams-sideload',
    stepDescription: 'uploading the generated zip into Teams as a custom app',
    reshow: () => stepSideload({ ...args, zipPath: args.zipPath }),
    args,
  });
  if (gate === 'back') return 'back';
  args.completed.push('App sideloaded into Teams.');
  return 'continue';
}

// ─── step: install adapter ─────────────────────────────────────────────

async function installAdapter(collected: Collected): Promise<void> {
  const env: Record<string, string> = {
    TEAMS_APP_ID: collected.appId!,
    TEAMS_APP_PASSWORD: collected.appPassword!,
    TEAMS_APP_TYPE: collected.appType!,
  };
  if (collected.appType === 'SingleTenant') {
    env.TEAMS_APP_TENANT_ID = collected.tenantId!;
  }

  const install = await runQuietChild(
    'teams-install',
    'bash',
    ['setup/add-teams.sh'],
    {
      running: 'Installing the Teams adapter and restarting the service…',
      done: 'Teams adapter installed.',
    },
    {
      env,
      extraFields: {
        APP_ID: collected.appId!,
        APP_TYPE: collected.appType!,
      },
    },
  );
  if (!install.ok) {
    fail(
      'teams-install',
      "Couldn't install the Teams adapter.",
      'See logs/setup-steps/ for details, then retry setup.',
    );
  }
}

// ─── post-install: hand off for the final wiring ──────────────────────

async function finishWithHandoff(
  collected: Collected,
  completed: string[],
): Promise<void> {
  note(
    [
      'The Teams adapter is live and the service is running.',
      '',
      "One thing left: your Teams bot's platform ID (which NanoClaw needs",
      'to wire to an agent group) only becomes known after you DM the bot',
      'for the first time. Your AI-coding CLI can walk you through that interactively —',
      'watch the logs for your first inbound, find the auto-created',
      'messaging group in the DB, run scripts/init-first-agent.ts with',
      'the right flags, and verify end-to-end.',
    ].join('\n'),
    'Step 6 of 6 — Finish wiring',
  );

  const choice = ensureAnswer(
    await brightSelect({
      message: 'Ready to finish?',
      options: [
        {
          value: 'handoff',
          label: 'Hand me off to walk me through it',
          hint: 'recommended',
        },
        { value: 'self', label: "I'll do it myself" },
      ],
    }),
  );

  if (choice === 'self') {
    note(
      [
        '  1. Find your bot in Teams (search by name, or via the sideloaded',
        '     app) and send it a message ("hi" is fine)',
        '  2. Tail ' + k.cyan('logs/nanoclaw.log') + ' for the inbound; the router',
        '     auto-creates a row in ' + k.cyan('messaging_groups') + ' in data/v2.db',
        '  3. Run ' + k.cyan('scripts/init-first-agent.ts') + ' with --channel teams,',
        '     the discovered platform_id, and your AAD user id, OR use',
        '     ' + k.cyan('/manage-channels') + ' to wire interactively',
      ].join('\n'),
      'Manual finish',
    );
    return;
  }

  await offerAiCodingCliHandoff({
    channel: CHANNEL,
    step: 'teams-finish-wiring',
    stepDescription:
      'finishing the Teams wiring: watch for the first inbound, discover the auto-created messaging group in data/v2.db, and run scripts/init-first-agent.ts to wire it to an agent group',
    completedSteps: completed,
    collectedValues: redactCollected(collected),
    files: [
      'scripts/init-first-agent.ts',
      'src/router.ts',
      'src/db/messaging-groups.ts',
      'logs/nanoclaw.log',
      '.claude/skills/manage-channels/SKILL.md',
    ],
  });
}

// ─── shared step gate ──────────────────────────────────────────────────

async function stepGate(args: {
  stepName: string;
  stepDescription: string;
  reshow: () => Promise<'continue' | 'back'>;
  args: { collected: Collected; completed: string[] };
}): Promise<'continue' | 'back'> {
  while (true) {
    const choice = ensureAnswer(
      await brightSelect({
        message: 'How did that go?',
        options: [
          { value: 'done', label: "Done — let's continue" },
          { value: 'help', label: 'Stuck — hand me off for help' },
          { value: 'reshow', label: 'Show me the steps again' },
          { value: 'back', label: '← Back to channel selection' },
        ],
      }),
    );
    if (choice === 'done') return 'continue';
    if (choice === 'back') return 'back';
    if (choice === 'help') {
      await offerHandoff({
        step: args.stepName,
        stepDescription: args.stepDescription,
        args: args.args,
      });
      continue;
    }
    if (choice === 'reshow') {
      return args.reshow();
    }
  }
}

async function offerHandoff(args: {
  step: string;
  stepDescription: string;
  args: { collected: Collected; completed: string[] };
}): Promise<void> {
  const ctx: HandoffContext = {
    channel: CHANNEL,
    step: args.step,
    stepDescription: args.stepDescription,
    completedSteps: args.args.completed.slice(),
    collectedValues: redactCollected(args.args.collected),
    files: ['setup/channels/teams.ts', 'setup/add-teams.sh'],
  };
  await offerAiCodingCliHandoff(ctx);
}

function redactCollected(c: Collected): Record<string, string> {
  const out: Record<string, string> = {};
  if (c.publicUrl) out.publicUrl = c.publicUrl;
  if (c.appId) out.appId = c.appId;
  if (c.tenantId) out.tenantId = c.tenantId;
  if (c.appType) out.appType = c.appType;
  if (c.appPassword) {
    out.appPassword = `${c.appPassword.slice(0, 4)}…${c.appPassword.slice(-4)}`;
  }
  return out;
}

// ─── shared: UUID paste with help escape ───────────────────────────────

async function askUuid(
  message: string,
  logKey: string,
  args: { collected: Collected; completed: string[] },
): Promise<string> {
  while (true) {
    const answer = ensureAnswer(
      await p.text({
        message,
        placeholder: '00000000-0000-0000-0000-000000000000',
        validate: validateWithHelpEscape((v) => {
          const t = (v ?? '').trim();
          if (!t) return 'Required';
          if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(t)) {
            return 'Expected a UUID like 00000000-0000-0000-0000-000000000000';
          }
          return undefined;
        }),
      }),
    );
    if (isHelpEscape(answer)) {
      await offerHandoff({
        step: logKey,
        stepDescription: `entering a UUID for ${logKey}`,
        args,
      });
      continue;
    }
    const value = (answer as string).trim().toLowerCase();
    setupLog.userInput(logKey, value);
    return value;
  }
}

// ─── path helpers ──────────────────────────────────────────────────────

function shortPath(abs: string): string {
  const home = os.homedir();
  const cwd = process.cwd();
  if (abs.startsWith(`${cwd}/`)) return abs.slice(cwd.length + 1);
  if (abs.startsWith(`${home}/`)) return `~/${abs.slice(home.length + 1)}`;
  return abs;
}

