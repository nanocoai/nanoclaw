/**
 * Slack channel flow for setup:auto.
 *
 * `runSlackChannel(displayName)` walks the operator from a bare Slack
 * workspace through a running bot, then stops before wiring an agent:
 *
 *   1. Ask the delivery mode: Socket Mode (outbound WebSocket, no public
 *      URL) or a public webhook
 *   2. Walk through creating a Slack app (api.slack.com/apps) — scopes,
 *      events, and the mode-specific credential (app-level token for
 *      Socket Mode, signing secret for webhook)
 *   3. Paste the bot token + that credential (clack password prompts)
 *   4. Validate via auth.test → resolves workspace + bot identity
 *   5. Install the adapter (setup/add-slack.sh, non-interactive)
 *   6. Print the post-install checklist (Socket Mode: just DM the bot;
 *      webhook: set the public Request URL in Event Subscriptions), then
 *      `/manage-channels` to wire an agent.
 *
 * Why no welcome DM here: opening an unsolicited DM would need `im:write`
 * scope we don't force the SKILL.md to require — and in webhook mode inbound
 * events don't flow until the public Event Subscriptions URL is configured.
 * Shipping an honest "here's what's left" note is better than a welcome DM
 * the user won't receive until they finish wiring Slack up.
 *
 * All output obeys the three-level contract. See docs/setup-flow.md.
 */
import * as p from '@clack/prompts';
import k from 'kleur';

import * as setupLog from '../logs.js';
import { brightSelect } from '../lib/bright-select.js';
import { confirmThenOpen } from '../lib/browser.js';
import { ensureAnswer, fail, runQuietChild } from '../lib/runner.js';
import { wrapForGutter } from '../lib/theme.js';

const SLACK_API = 'https://slack.com/api';
const SLACK_APPS_URL = 'https://api.slack.com/apps';

interface WorkspaceInfo {
  teamName: string;
  teamId: string;
  botName: string;
  botUserId: string;
}

// Socket Mode (SLACK_APP_TOKEN, xapp-…) needs no public URL; webhook mode
// (SLACK_SIGNING_SECRET) needs a public Request URL. The adapter picks the mode
// purely from SLACK_APP_TOKEN's presence — this choice just decides which
// credential to collect and which post-install guidance to show.
type SlackMode = 'socket' | 'webhook';

// displayName is reserved for when we start wiring the first agent here.
// Kept to match the `run<X>Channel(displayName)` signature every other
// channel driver uses, so auto.ts can dispatch without a branch.
export async function runSlackChannel(_displayName: string): Promise<void> {
  const mode = await askSlackMode();
  await walkThroughAppCreation(mode);

  const token = await collectBotToken();
  const appToken = mode === 'socket' ? await collectAppToken() : undefined;
  const signingSecret = mode === 'webhook' ? await collectSigningSecret() : undefined;
  const info = await validateSlackToken(token);

  const env: Record<string, string> = { SLACK_BOT_TOKEN: token };
  if (appToken) env.SLACK_APP_TOKEN = appToken;
  if (signingSecret) env.SLACK_SIGNING_SECRET = signingSecret;

  const install = await runQuietChild(
    'slack-install',
    'bash',
    ['setup/add-slack.sh'],
    {
      running: `Connecting Slack to @${info.botName} (${info.teamName})…`,
      done: 'Slack adapter installed.',
    },
    {
      env,
      extraFields: {
        MODE: mode,
        BOT_NAME: info.botName,
        TEAM_NAME: info.teamName,
        TEAM_ID: info.teamId,
      },
    },
  );
  if (!install.ok) {
    await fail('slack-install', "Couldn't connect Slack.", 'See logs/setup-steps/ for details, then retry setup.');
  }

  showPostInstallChecklist(info, mode);
}

async function askSlackMode(): Promise<SlackMode> {
  const choice = ensureAnswer(
    await brightSelect<SlackMode>({
      message: 'How should Slack deliver events to NanoClaw?',
      initialValue: 'socket',
      options: [
        {
          value: 'socket',
          label: 'Socket Mode',
          hint: 'no public URL — recommended for local or behind NAT',
        },
        {
          value: 'webhook',
          label: 'Public webhook',
          hint: 'needs a public HTTPS Request URL',
        },
      ],
    }),
  );
  setupLog.userInput('slack_mode', String(choice));
  return choice;
}

async function walkThroughAppCreation(mode: SlackMode): Promise<void> {
  const credSteps =
    mode === 'socket'
      ? [
          '  4. Basic Information → App-Level Tokens → "Generate Token and',
          '     Scopes" → add the connections:write scope → copy it (xapp-…)',
          '  5. Socket Mode → toggle "Enable Socket Mode" on',
          '  6. Install to Workspace → copy the "Bot User OAuth Token" (xoxb-…)',
        ]
      : [
          '  4. Basic Information → copy the "Signing Secret"',
          '  5. Install to Workspace → copy the "Bot User OAuth Token" (xoxb-…)',
        ];
  p.note(
    [
      "You'll create a Slack app that the assistant talks through.",
      'Free and stays inside the workspaces you pick.',
      '',
      '  1. Create a new app "From scratch", name it, pick a workspace',
      '  2. OAuth & Permissions → add Bot Token Scopes:',
      '     chat:write, channels:history, groups:history, im:history,',
      '     channels:read, groups:read, users:read, reactions:write',
      '  3. App Home → enable "Messages Tab" and "Allow users to send',
      '     slash commands and messages from the messages tab"',
      ...credSteps,
      '',
      k.dim(SLACK_APPS_URL),
    ].join('\n'),
    'Create a Slack app',
  );
  await confirmThenOpen(SLACK_APPS_URL, 'Press Enter to open Slack app settings');

  ensureAnswer(
    await p.confirm({
      message: mode === 'socket' ? 'Got your bot token and app-level token?' : 'Got your bot token and signing secret?',
      initialValue: true,
    }),
  );
}

async function collectBotToken(): Promise<string> {
  const answer = ensureAnswer(
    await p.password({
      message: 'Paste your Slack bot token',
      validate: (v) => {
        const t = (v ?? '').trim();
        if (!t) return 'Token is required';
        if (!t.startsWith('xoxb-')) return 'Bot tokens start with xoxb-';
        if (t.length < 24) return "That's shorter than a real Slack bot token";
        return undefined;
      },
    }),
  );
  const token = (answer as string).trim();
  setupLog.userInput('slack_bot_token', `${token.slice(0, 10)}…${token.slice(-4)}`);
  return token;
}

async function collectSigningSecret(): Promise<string> {
  const answer = ensureAnswer(
    await p.password({
      message: 'Paste your Slack signing secret',
      validate: (v) => {
        const t = (v ?? '').trim();
        if (!t) return 'Signing secret is required';
        // Slack signing secrets are 32-char hex strings, but newer apps
        // sometimes emit longer variants — leniently require hex only.
        if (!/^[a-f0-9]{16,}$/i.test(t)) {
          return 'Signing secrets are a string of hex characters';
        }
        return undefined;
      },
    }),
  );
  const secret = (answer as string).trim();
  setupLog.userInput('slack_signing_secret', `${secret.slice(0, 4)}…${secret.slice(-4)}`);
  return secret;
}

async function collectAppToken(): Promise<string> {
  const answer = ensureAnswer(
    await p.password({
      message: 'Paste your Slack app-level token (Socket Mode)',
      validate: (v) => {
        const t = (v ?? '').trim();
        if (!t) return 'App-level token is required for Socket Mode';
        if (!t.startsWith('xapp-')) return 'App-level tokens start with xapp-';
        if (t.length < 24) return "That's shorter than a real Slack app-level token";
        return undefined;
      },
    }),
  );
  const token = (answer as string).trim();
  setupLog.userInput('slack_app_token', `${token.slice(0, 10)}…${token.slice(-4)}`);
  return token;
}

async function validateSlackToken(token: string): Promise<WorkspaceInfo> {
  const s = p.spinner();
  const start = Date.now();
  s.start('Checking your bot token…');
  try {
    const res = await fetch(`${SLACK_API}/auth.test`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    const data = (await res.json()) as {
      ok?: boolean;
      team?: string;
      team_id?: string;
      user?: string;
      user_id?: string;
      error?: string;
    };
    const elapsedS = Math.round((Date.now() - start) / 1000);
    if (data.ok && data.team && data.user) {
      s.stop(`Connected to ${data.team} as @${data.user}. ${k.dim(`(${elapsedS}s)`)}`);
      const info: WorkspaceInfo = {
        teamName: data.team,
        teamId: data.team_id ?? '',
        botName: data.user,
        botUserId: data.user_id ?? '',
      };
      setupLog.step('slack-validate', 'success', Date.now() - start, {
        BOT_NAME: info.botName,
        BOT_USER_ID: info.botUserId,
        TEAM_NAME: info.teamName,
        TEAM_ID: info.teamId,
      });
      return info;
    }
    const reason = data.error ?? `HTTP ${res.status}`;
    s.stop(`Slack didn't accept that token: ${reason}`, 1);
    setupLog.step('slack-validate', 'failed', Date.now() - start, {
      ERROR: reason,
    });
    await fail(
      'slack-validate',
      "Slack didn't accept that token.",
      reason === 'invalid_auth' || reason === 'token_revoked'
        ? 'Copy the token again from OAuth & Permissions and retry setup.'
        : `Slack said "${reason}". Check the token scopes and workspace install, then retry.`,
    );
  } catch (err) {
    const elapsedS = Math.round((Date.now() - start) / 1000);
    s.stop(`Couldn't reach Slack. ${k.dim(`(${elapsedS}s)`)}`, 1);
    const message = err instanceof Error ? err.message : String(err);
    setupLog.step('slack-validate', 'failed', Date.now() - start, {
      ERROR: message,
    });
    await fail('slack-validate', "Couldn't reach Slack.", 'Check your internet connection and retry setup.');
  }
}

function showPostInstallChecklist(info: WorkspaceInfo, mode: SlackMode): void {
  if (mode === 'socket') {
    p.note(
      wrapForGutter(
        [
          `The Slack adapter is installed in Socket Mode and your creds are saved. No public URL needed — ${info.teamName} reaches NanoClaw over an outbound WebSocket.`,
          '',
          `  1. DM @${info.botName} from Slack once — that bootstraps the`,
          '     messaging group. Then run `/manage-channels` in `claude` to',
          '     wire an agent to it.',
          '',
          '  Note: keep the NanoClaw host running to hold the socket open —',
          '  Slack does not retry delivery while it is down.',
        ].join('\n'),
        6,
      ),
      'Finish setting up Slack',
    );
    return;
  }
  p.note(
    wrapForGutter(
      [
        `The Slack adapter is installed and your creds are saved. ${info.teamName} still needs two things before it can talk to you:`,
        '',
        '  1. A public URL so Slack can deliver events.',
        '     NanoClaw serves a webhook on port 3000 by default — expose it',
        '     via ngrok, Cloudflare Tunnel, or a reverse proxy on a VPS.',
        '',
        '  2. In your Slack app → Event Subscriptions:',
        '     • Toggle "Enable Events" on',
        `     • Request URL: https://<your-public-host>/webhook/slack`,
        '     • Subscribe to bot events: message.channels, message.groups,',
        '       message.im, app_mention',
        '     • Save, then reinstall the app when Slack prompts',
        '',
        `  3. DM @${info.botName} from Slack once — that bootstraps the`,
        '     messaging group. Then run `/manage-channels` in `claude` to',
        '     wire an agent to it.',
      ].join('\n'),
      6,
    ),
    'Finish setting up Slack',
  );
}
