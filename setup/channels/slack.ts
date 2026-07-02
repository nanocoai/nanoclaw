/**
 * Slack channel flow for setup:auto.
 *
 * `runSlackChannel(displayName)` owns the full branch from creating a
 * Slack app through the welcome DM:
 *
 *   1. Ask the delivery mode: Socket Mode (outbound WebSocket, no public
 *      URL) or a public webhook
 *   2. Walk through creating a Slack app (api.slack.com/apps) — scopes,
 *      events, and the mode-specific credential (app-level token for
 *      Socket Mode, signing secret for webhook)
 *   3. Paste the bot token + that credential (clack password prompts)
 *   4. Validate via auth.test → resolves workspace + bot identity
 *   5. Install the adapter (setup/add-slack.sh, non-interactive)
 *   6. Ask for the operator's Slack user ID
 *   7. conversations.open to get the DM channel ID
 *   8. Ask for the messaging-agent name (defaulting to "Nano")
 *   9. Wire the agent via scripts/init-first-agent.ts
 *
 * The welcome DM is sent via outbound delivery (chat.postMessage), which
 * works without Event Subscriptions being configured. The user sees the
 * greeting in Slack immediately; inbound replies require webhooks, so the
 * post-install note covers that.
 *
 * All output obeys the three-level contract. See docs/setup-flow.md.
 */
import * as p from '@clack/prompts';
import k from 'kleur';

import * as setupLog from '../logs.js';
import { BACK_TO_CHANNEL_SELECTION, type ChannelFlowResult } from '../lib/back-nav.js';
import { brightSelect } from '../lib/bright-select.js';
import { openUrl } from '../lib/browser.js';
import { isHeadless } from '../platform.js';
import { askOperatorRole } from '../lib/role-prompt.js';
import { ensureAnswer, fail, runQuietChild } from '../lib/runner.js';
import { readEnvKey } from '../environment.js';
import { accentGreen, fmtDuration, note, wrapForGutter } from '../lib/theme.js';

const SLACK_API = 'https://slack.com/api';
const SLACK_APPS_URL = 'https://api.slack.com/apps';
const DEFAULT_AGENT_NAME = 'Nano';

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

export async function runSlackChannel(displayName: string): Promise<ChannelFlowResult> {
  const mode = await askSlackMode();
  const intro = await walkThroughAppCreation(mode);
  if (intro === 'back') return BACK_TO_CHANNEL_SELECTION;

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
    await fail(
      'slack-install',
      "Couldn't connect Slack.",
      'See logs/setup-steps/ for details, then retry setup.',
    );
  }

  const ownerUserId = await collectSlackUserId();
  const dmChannelId = await openDmChannel(token, ownerUserId);
  const platformId = `slack:${dmChannelId}`;

  const role = await askOperatorRole('Slack');
  setupLog.userInput('slack_role', role);

  const agentName = await resolveAgentName();

  const init = await runQuietChild(
    'init-first-agent',
    'pnpm',
    [
      'exec', 'tsx', 'scripts/init-first-agent.ts',
      '--channel', 'slack',
      '--user-id', `slack:${ownerUserId}`,
      '--platform-id', platformId,
      '--display-name', displayName,
      '--agent-name', agentName,
      '--role', role,
    ],
    {
      running: `Wiring ${agentName} to your Slack DMs…`,
      done: 'Agent wired.',
    },
    {
      extraFields: {
        CHANNEL: 'slack',
        AGENT_NAME: agentName,
        PLATFORM_ID: platformId,
      },
    },
  );
  if (!init.ok) {
    await fail(
      'init-first-agent',
      `Couldn't finish connecting ${agentName}.`,
      'You can retry later with `/init-first-agent` in Claude Code.',
    );
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

async function walkThroughAppCreation(mode: SlackMode): Promise<'continue' | 'back'> {
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
  // Bright-white ANSI overrides the surrounding brand-cyan from `note()`'s
  // per-line formatter so the URL stands out against the rest of the body.
  const linkBlock = isHeadless()
    ? [`\x1b[97mGet started: ${SLACK_APPS_URL}\x1b[39m`, '']
    : [];

  note(
    [
      "You'll create a Slack app that the assistant talks through.",
      "Free and stays inside the workspaces you pick.",
      '',
      ...linkBlock,
      '  1. Create a new app "From scratch", name it, pick a workspace',
      '  2. OAuth & Permissions → add Bot Token Scopes:',
      '     • im:write, im:history',
      '     • channels:read, channels:history',
      '     • groups:read, groups:history',
      '     • chat:write',
      '     • users:read',
      '     • reactions:write',
      '     • files:read, files:write',
      '  3. App Home → enable "Messages Tab" and "Allow users to send',
      '     slash commands and messages from the messages tab"',
      ...credSteps,
    ].join('\n'),
    'Create a Slack app',
  );

  // Back-aware gate replacing the old `confirmThenOpen` "Press Enter to open
  // Slack app settings" so users can bail out of Slack before we open the
  // browser or ask for tokens.
  const choice = ensureAnswer(await brightSelect<'open' | 'back'>({
    message: 'Open Slack app settings in your browser?',
    options: [
      { value: 'open', label: 'Open Slack app settings' },
      { value: 'back', label: '← Back to channel selection' },
    ],
    initialValue: 'open',
  }));
  if (choice === 'back') return 'back';
  if (!isHeadless()) openUrl(SLACK_APPS_URL);

  ensureAnswer(
    await p.confirm({
      message:
        mode === 'socket'
          ? 'Got your bot token and app-level token?'
          : 'Got your bot token and signing secret?',
      initialValue: true,
    }),
  );
  return 'continue';
}

async function collectBotToken(): Promise<string> {
  const existing = readEnvKey('SLACK_BOT_TOKEN');
  if (existing && existing.startsWith('xoxb-') && existing.length >= 24) {
    const reuse = ensureAnswer(await p.confirm({
      message: `Found an existing Slack bot token (${existing.slice(0, 10)}…). Use it?`,
      initialValue: true,
    }));
    if (reuse) {
      setupLog.userInput('slack_bot_token', 'reused-existing');
      return existing;
    }
  }

  const answer = ensureAnswer(
    await p.password({
      message: 'Paste your Slack bot token',
      clearOnError: true,
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
  setupLog.userInput(
    'slack_bot_token',
    `${token.slice(0, 10)}…${token.slice(-4)}`,
  );
  return token;
}

async function collectSigningSecret(): Promise<string> {
  const existing = readEnvKey('SLACK_SIGNING_SECRET');
  if (existing && /^[a-f0-9]{16,}$/i.test(existing)) {
    const reuse = ensureAnswer(await p.confirm({
      message: 'Found an existing Slack signing secret. Use it?',
      initialValue: true,
    }));
    if (reuse) {
      setupLog.userInput('slack_signing_secret', 'reused-existing');
      return existing;
    }
  }

  const answer = ensureAnswer(
    await p.password({
      message: 'Paste your Slack signing secret',
      clearOnError: true,
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
  setupLog.userInput(
    'slack_signing_secret',
    `${secret.slice(0, 4)}…${secret.slice(-4)}`,
  );
  return secret;
}

async function collectAppToken(): Promise<string> {
  const existing = readEnvKey('SLACK_APP_TOKEN');
  if (existing && existing.startsWith('xapp-') && existing.length >= 24) {
    const reuse = ensureAnswer(await p.confirm({
      message: `Found an existing Slack app-level token (${existing.slice(0, 10)}…). Use it?`,
      initialValue: true,
    }));
    if (reuse) {
      setupLog.userInput('slack_app_token', 'reused-existing');
      return existing;
    }
  }

  const answer = ensureAnswer(
    await p.password({
      message: 'Paste your Slack app-level token (Socket Mode)',
      clearOnError: true,
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
  setupLog.userInput(
    'slack_app_token',
    `${token.slice(0, 10)}…${token.slice(-4)}`,
  );
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
    if (data.ok && data.team && data.user) {
      s.stop(
        `Connected to ${data.team} as @${data.user}. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`,
      );
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
    s.stop(`Couldn't reach Slack. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`, 1);
    const message = err instanceof Error ? err.message : String(err);
    setupLog.step('slack-validate', 'failed', Date.now() - start, {
      ERROR: message,
    });
    await fail(
      'slack-validate',
      "Couldn't reach Slack.",
      'Check your internet connection and retry setup.',
    );
  }
}

async function collectSlackUserId(): Promise<string> {
  note(
    [
      "To get your Slack member ID:",
      '',
      '  1. In Slack, click your profile picture (bottom left)',
      '  2. Click "Profile"',
      '  3. Click the three dots (⋮) → "Copy member ID"',
    ].join('\n'),
    'Find your Slack user ID',
  );
  const answer = ensureAnswer(
    await p.text({
      message: 'Paste your Slack member ID',
      validate: (v) => {
        const t = (v ?? '').trim();
        if (!t) return 'Member ID is required';
        if (!/^U[A-Z0-9]{8,}$/.test(t)) {
          return "That doesn't look like a Slack member ID (starts with U)";
        }
        return undefined;
      },
    }),
  );
  const id = (answer as string).trim();
  setupLog.userInput('slack_user_id', id);
  return id;
}

async function openDmChannel(token: string, userId: string): Promise<string> {
  const s = p.spinner();
  const start = Date.now();
  s.start('Opening a DM channel…');
  try {
    const res = await fetch(`${SLACK_API}/conversations.open`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ users: userId }),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      channel?: { id?: string };
      error?: string;
    };
    if (data.ok && data.channel?.id) {
      s.stop(`DM channel ready. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`);
      setupLog.step('slack-open-dm', 'success', Date.now() - start, {
        DM_CHANNEL_ID: data.channel.id,
      });
      return data.channel.id;
    }
    const reason = data.error ?? `HTTP ${res.status}`;
    s.stop(`Couldn't open a DM channel: ${reason}`, 1);
    setupLog.step('slack-open-dm', 'failed', Date.now() - start, {
      ERROR: reason,
    });
    if (reason === 'missing_scope') {
      await fail(
        'slack-open-dm',
        "Your Slack app is missing the im:write scope.",
        'Go to OAuth & Permissions in your Slack app settings, add the im:write scope, reinstall the app, then retry setup.',
      );
    }
    await fail(
      'slack-open-dm',
      "Couldn't open a DM channel with you.",
      `Slack said "${reason}". Check the member ID and app permissions, then retry.`,
    );
  } catch (err) {
    s.stop(`Couldn't reach Slack. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`, 1);
    const message = err instanceof Error ? err.message : String(err);
    setupLog.step('slack-open-dm', 'failed', Date.now() - start, {
      ERROR: message,
    });
    await fail(
      'slack-open-dm',
      "Couldn't reach Slack.",
      'Check your internet connection and retry setup.',
    );
  }
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

function showPostInstallChecklist(info: WorkspaceInfo, mode: SlackMode): void {
  if (mode === 'socket') {
    note(
      wrapForGutter(
        [
          `Your agent is wired to Slack and a welcome DM is on its way.`,
          `Socket Mode is on — ${info.teamName} reaches NanoClaw over an outbound`,
          `WebSocket, so there's no public URL to configure.`,
          '',
          '  • Just DM @' + info.botName + ' from Slack — replies flow straight away.',
          '',
          '  • Keep the NanoClaw host running to hold the socket open —',
          '    Slack does not retry delivery while it is down.',
        ].join('\n'),
        6,
      ),
      'Finish setting up Slack',
    );
    return;
  }
  note(
    wrapForGutter(
      [
        `Your agent is wired to Slack and a welcome DM is on its way.`,
        `To receive replies, Slack needs a public URL for delivering events:`,
        '',
        '  1. Expose NanoClaw\'s webhook server (port 3000) via ngrok,',
        '     Cloudflare Tunnel, or a reverse proxy on a VPS.',
        '',
        '  2. In your Slack app → Event Subscriptions:',
        '     • Toggle "Enable Events" on',
        `     • Request URL: https://<your-public-host>/webhook/slack`,
        '     • Subscribe to bot events: message.channels, message.groups,',
        '       message.im, app_mention',
        '     • Save Changes',
        '',
        '  3. In your Slack app → Interactivity & Shortcuts:',
        '     • Toggle "Interactivity" on',
        `     • Request URL: https://<your-public-host>/webhook/slack`,
        '     • Save Changes',
        '',
        '  4. Slack will prompt you to reinstall the app — do it to apply',
        '     the new settings',
      ].join('\n'),
      6,
    ),
    'Finish setting up Slack',
  );
}
