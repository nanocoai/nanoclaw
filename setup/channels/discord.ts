/**
 * Discord channel flow for setup:auto.
 *
 * `runDiscordChannel(displayName)` owns the full branch from "do you have a
 * bot?" through the welcome DM:
 *
 *   1. Ask if they have a bot already; walk them through Dev Portal creation
 *      if not
 *   2. Paste the bot token (clack password) — format-validated
 *   3. GET /users/@me to confirm the token and resolve bot username
 *   4. GET /oauth2/applications/@me to derive application_id, verify_key
 *      (public key), and owner — no separate paste needed in the common case
 *   5. Confirm owner identity (falls back to a manual user-id prompt with
 *      Developer Mode instructions if declined or if the app is team-owned)
 *   6. Print the OAuth invite URL, open it, wait for "I've added the bot"
 *   7. Install the adapter via setup/add-discord.sh (non-interactive)
 *   8. POST /users/@me/channels to open the DM channel (yields dm channel id)
 *   9. Ask for the messaging-agent name (defaulting to "Nano")
 *  10. Wire the agent via scripts/init-first-agent.ts, which sends the welcome
 *      DM through the normal delivery path
 *
 * All output obeys the three-level contract: clack UI for the user, structured
 * entries in logs/setup.log, full raw output in per-step files under
 * logs/setup-steps/. See docs/setup-flow.md.
 */
import * as p from '@clack/prompts';
import k from 'kleur';

import * as setupLog from '../logs.js';
import { BACK_TO_CHANNEL_SELECTION, type ChannelFlowResult } from '../lib/back-nav.js';
import { brightSelect } from '../lib/bright-select.js';
import { confirmThenOpen, formatNoteLink } from '../lib/browser.js';
import { askOperatorRole } from '../lib/role-prompt.js';
import { buildFirstAgentStepArgs, type FirstAgentProviderOptions } from '../lib/first-agent-args.js';
import { ensureAnswer, fail, runQuietChild } from '../lib/runner.js';
import { readEnvKey } from '../environment.js';
import { accentGreen, brandBody, fmtDuration, note } from '../lib/theme.js';

const DEFAULT_AGENT_NAME = 'Nano';
const DISCORD_API = 'https://discord.com/api/v10';

// Send Messages (0x800) + Add Reactions (0x40) + Attach Files (0x8000)
//   + Read Message History (0x10000) = 100416.
// Matches the permissions set documented in .claude/skills/add-discord/SKILL.md.
const INVITE_PERMISSIONS = '100416';

interface AppInfo {
  applicationId: string;
  publicKey: string;
  owner: { id: string; username: string } | null;
}

export async function runDiscordChannel(
  displayName: string,
  providerOptions: FirstAgentProviderOptions = {},
): Promise<ChannelFlowResult> {
  const choice = await askHasBotToken();
  if (choice === 'back') return BACK_TO_CHANNEL_SELECTION;
  const hasBot = choice === 'yes';
  if (!hasBot) {
    await walkThroughBotCreation();
  }
  // Even users who said "yes" often can't find the token on demand — the
  // Dev Portal resets it if you don't store it, and people forget which
  // app it belongs to. A quick reminder before the paste prompt is cheap.
  showTokenLocationReminder(hasBot);

  const token = await collectDiscordToken();
  const botUsername = await validateDiscordToken(token);
  const app = await fetchApplicationInfo(token);

  const ownerUserId = await resolveOwnerUserId(app.owner);

  // Before inviting: do they have a server to invite into? Walkthrough if
  // not — a fresh Discord account without a server makes the invite page a
  // dead end.
  if (!(await askHasDiscordServer())) {
    await walkThroughServerCreation();
  }

  await promptInviteBot(app.applicationId, botUsername);

  const install = await runQuietChild(
    'discord-install',
    'bash',
    ['setup/add-discord.sh'],
    {
      running: `Connecting Discord to @${botUsername}…`,
      done: 'Discord connected.',
    },
    {
      env: {
        DISCORD_BOT_TOKEN: token,
        DISCORD_APPLICATION_ID: app.applicationId,
        DISCORD_PUBLIC_KEY: app.publicKey,
      },
      extraFields: {
        BOT_USERNAME: botUsername,
        APPLICATION_ID: app.applicationId,
      },
    },
  );
  if (!install.ok) {
    await fail(
      'discord-install',
      "Couldn't connect Discord.",
      'See logs/setup-steps/ for details, then retry setup.',
    );
  }

  const dmChannelId = await openDmChannel(token, ownerUserId);
  const platformId = `discord:@me:${dmChannelId}`;

  const role = await askOperatorRole('Discord');
  setupLog.userInput('discord_role', role);

  const agentName = await resolveAgentName();

  const init = await runQuietChild(
    'init-first-agent',
    'pnpm',
    buildFirstAgentStepArgs({
      channel: 'discord',
      userId: `discord:${ownerUserId}`,
      platformId,
      displayName,
      agentName,
      role,
      ...providerOptions,
    }),
    {
      running: `Connecting ${agentName} to your Discord DMs…`,
      done: `${agentName} is ready. Check Discord for a welcome message.`,
    },
    {
      extraFields: {
        CHANNEL: 'discord',
        AGENT_NAME: agentName,
        PLATFORM_ID: platformId,
      },
    },
  );
  if (!init.ok) {
    await fail(
      'init-first-agent',
      `Couldn't finish connecting ${agentName}.`,
      'Most likely the bot and you don\'t share a server yet — invite the bot, then retry later with `/manage-channels`.',
    );
  }
}

async function askHasBotToken(): Promise<'yes' | 'no' | 'back'> {
  const answer = ensureAnswer(
    await brightSelect({
      message: 'Do you already have a Discord bot?',
      options: [
        { value: 'yes', label: 'Yes, I have a bot token ready' },
        { value: 'no', label: "No, walk me through creating one" },
        { value: 'back', label: '← Back to channel selection' },
      ],
    }),
  );
  return answer as 'yes' | 'no' | 'back';
}

async function walkThroughBotCreation(): Promise<void> {
  const url = 'https://discord.com/developers/applications';
  note(
    [
      "You'll create a Discord bot in the Developer Portal. It's free and takes about a minute.",
      '',
      '  1. Click "New Application", give it a name (e.g. "NanoClaw")',
      '  2. In the "Bot" tab, click "Reset Token" and copy the token',
      '  3. On the same tab, enable "Message Content Intent"',
      '     (under Privileged Gateway Intents)',
      formatNoteLink(url),
    ].filter((line): line is string => line !== null).join('\n'),
    'Create a Discord bot',
  );
  await confirmThenOpen(url, 'Press Enter to open the Developer Portal');

  ensureAnswer(
    await p.confirm({
      message: "Got your bot token?",
      initialValue: true,
    }),
  );
}

function showTokenLocationReminder(hasExistingBot: boolean): void {
  // If we just walked them through creating a bot, they're staring at the
  // token. If they came in with an existing one, they may still need a nudge
  // to find it — tokens in the Dev Portal aren't visible after first reveal,
  // and "Reset Token" issues a new one.
  if (hasExistingBot) {
    note(
      [
        "Where to find your bot token:",
        '',
        '  1. discord.com/developers/applications → pick your app',
        '  2. "Bot" tab → "Reset Token" (the old one stops working)',
        '  3. Copy the new token',
      ].join('\n'),
      'Reminder',
    );
  }
}

async function askHasDiscordServer(): Promise<boolean> {
  const answer = ensureAnswer(
    await brightSelect({
      message: 'Do you have a Discord server you can add the bot to?',
      options: [
        { value: 'yes', label: 'Yes, I have a server' },
        { value: 'no', label: "No, walk me through creating one" },
      ],
    }),
  );
  setupLog.userInput('discord_has_server', String(answer));
  return answer === 'yes';
}

async function walkThroughServerCreation(): Promise<void> {
  // Discord doesn't have a stable deep-link for "create server" so we open
  // the web client and rely on the + button being visible. The steps below
  // are the same whether they're in the desktop app or the browser.
  const url = 'https://discord.com/channels/@me';
  note(
    [
      "A Discord server is just a private space for you and the bot. Free and takes 30 seconds.",
      '',
      '  1. In Discord, click the "+" at the bottom of the server list',
      '  2. Choose "Create My Own" → "For me and my friends"',
      '  3. Give it any name (e.g. "NanoClaw")',
      formatNoteLink(url),
    ].filter((line): line is string => line !== null).join('\n'),
    'Create a Discord server',
  );
  await confirmThenOpen(url, 'Press Enter to open Discord');

  ensureAnswer(
    await p.confirm({
      message: "Server created?",
      initialValue: true,
    }),
  );
}

async function collectDiscordToken(): Promise<string> {
  const existing = readEnvKey('DISCORD_BOT_TOKEN');
  if (existing && /^[A-Za-z0-9._-]{50,}$/.test(existing)) {
    const reuse = ensureAnswer(await p.confirm({
      message: `Found an existing Discord bot token (${existing.slice(0, 10)}…). Use it?`,
      initialValue: true,
    }));
    if (reuse) {
      setupLog.userInput('discord_token', 'reused-existing');
      return existing;
    }
  }

  const answer = ensureAnswer(
    await p.password({
      message: 'Paste your bot token',
      clearOnError: true,
      validate: (v) => {
        const t = (v ?? '').trim();
        if (!t) return 'Token is required';
        // Discord bot tokens are base64url segments separated by dots.
        // Be lenient on length; the real check is /users/@me.
        if (!/^[A-Za-z0-9._-]{50,}$/.test(t)) {
          return "That doesn't look like a Discord bot token";
        }
        return undefined;
      },
    }),
  );
  const token = (answer as string).trim();
  setupLog.userInput(
    'discord_token',
    `${token.slice(0, 10)}…${token.slice(-4)}`,
  );
  return token;
}

async function validateDiscordToken(token: string): Promise<string> {
  const s = p.spinner();
  const start = Date.now();
  s.start('Checking your bot token…');
  try {
    const res = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bot ${token}` },
    });
    const data = (await res.json()) as {
      id?: string;
      username?: string;
      message?: string;
    };
    if (res.ok && data.username) {
      s.stop(`Found your bot: @${data.username}. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`);
      setupLog.step('discord-validate', 'success', Date.now() - start, {
        BOT_USERNAME: data.username,
        BOT_ID: data.id ?? '',
      });
      return data.username;
    }
    const reason = data.message ?? `HTTP ${res.status}`;
    s.stop(`Discord didn't accept that token: ${reason}`, 1);
    setupLog.step('discord-validate', 'failed', Date.now() - start, {
      ERROR: reason,
    });
    await fail(
      'discord-validate',
      "Discord didn't accept that token.",
      'Copy the token again from the Developer Portal and retry setup.',
    );
  } catch (err) {
    s.stop(`Couldn't reach Discord. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`, 1);
    const message = err instanceof Error ? err.message : String(err);
    setupLog.step('discord-validate', 'failed', Date.now() - start, {
      ERROR: message,
    });
    await fail(
      'discord-validate',
      "Couldn't reach Discord.",
      'Check your internet connection and retry setup.',
    );
  }
}

async function fetchApplicationInfo(token: string): Promise<AppInfo> {
  const s = p.spinner();
  const start = Date.now();
  s.start('Looking up your bot application…');
  try {
    const res = await fetch(`${DISCORD_API}/oauth2/applications/@me`, {
      headers: { Authorization: `Bot ${token}` },
    });
    const data = (await res.json()) as {
      id?: string;
      verify_key?: string;
      owner?: { id: string; username: string } | null;
      team?: unknown;
      message?: string;
    };
    if (!res.ok || !data.id || !data.verify_key) {
      const reason = data.message ?? `HTTP ${res.status}`;
      s.stop(`Couldn't read application info: ${reason}`, 1);
      setupLog.step('discord-app-info', 'failed', Date.now() - start, {
        ERROR: reason,
      });
      await fail(
        'discord-app-info',
        "Couldn't read your Discord application details.",
        'Re-run setup. If it keeps failing, check the bot token has the right scopes.',
      );
    }
    s.stop(`Got your application details. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`);
    // owner is populated for solo applications; team-owned apps return a
    // team object instead and we'll fall back to a manual user-id prompt.
    const owner =
      data.owner && data.owner.id && data.owner.username
        ? { id: data.owner.id, username: data.owner.username }
        : null;
    setupLog.step('discord-app-info', 'success', Date.now() - start, {
      APPLICATION_ID: data.id,
      OWNER_USERNAME: owner?.username ?? '',
      TEAM_OWNED: data.team ? 'true' : 'false',
    });
    return {
      applicationId: data.id,
      publicKey: data.verify_key,
      owner,
    };
  } catch (err) {
    s.stop(`Couldn't reach Discord. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`, 1);
    const message = err instanceof Error ? err.message : String(err);
    setupLog.step('discord-app-info', 'failed', Date.now() - start, {
      ERROR: message,
    });
    await fail(
      'discord-app-info',
      "Couldn't reach Discord.",
      'Check your internet connection and retry setup.',
    );
  }
}

async function resolveOwnerUserId(
  owner: { id: string; username: string } | null,
): Promise<string> {
  if (owner) {
    const confirmed = ensureAnswer(
      await p.confirm({
        message: `Is @${owner.username} your Discord account?`,
        initialValue: true,
      }),
    );
    if (confirmed === true) {
      setupLog.userInput('discord_owner_confirmed', owner.username);
      return owner.id;
    }
  } else {
    p.log.info(
      brandBody("Your bot is owned by a Developer Team, so we need your Discord user ID directly."),
    );
  }
  return await promptForUserIdWithDevMode();
}

async function promptForUserIdWithDevMode(): Promise<string> {
  note(
    [
      "To get your Discord user ID:",
      '',
      '  1. Open Discord → Settings (⚙️) → Advanced',
      '  2. Turn on "Developer Mode"',
      '  3. Right-click your own name/avatar → "Copy User ID"',
    ].join('\n'),
    'Find your Discord user ID',
  );
  const answer = ensureAnswer(
    await p.text({
      message: 'Paste your Discord user ID',
      validate: (v) => {
        const t = (v ?? '').trim();
        if (!t) return 'User ID is required';
        if (!/^\d{17,20}$/.test(t)) {
          return "That doesn't look like a Discord user ID (17-20 digits)";
        }
        return undefined;
      },
    }),
  );
  const id = (answer as string).trim();
  setupLog.userInput('discord_user_id', id);
  return id;
}

async function promptInviteBot(
  applicationId: string,
  botUsername: string,
): Promise<void> {
  const url =
    `https://discord.com/api/oauth2/authorize` +
    `?client_id=${applicationId}` +
    `&scope=bot` +
    `&permissions=${INVITE_PERMISSIONS}`;

  note(
    [
      `@${botUsername} needs to share a server with you before it can DM you.`,
      '',
      '  1. Pick any server you\'re in (a personal one is fine)',
      '  2. Click "Authorize"',
      formatNoteLink(url),
    ].filter((line): line is string => line !== null).join('\n'),
    'Add bot to a server',
  );
  await confirmThenOpen(url, 'Press Enter to open the invite page');

  ensureAnswer(
    await p.confirm({
      message: "I've added the bot to a server",
      initialValue: true,
    }),
  );
}

async function openDmChannel(token: string, userId: string): Promise<string> {
  const s = p.spinner();
  const start = Date.now();
  s.start('Opening a DM channel…');
  try {
    const res = await fetch(`${DISCORD_API}/users/@me/channels`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: userId }),
    });
    const data = (await res.json()) as { id?: string; message?: string };
    if (!res.ok || !data.id) {
      const reason = data.message ?? `HTTP ${res.status}`;
      s.stop(`Couldn't open a DM channel: ${reason}`, 1);
      setupLog.step('discord-open-dm', 'failed', Date.now() - start, {
        ERROR: reason,
      });
      await fail(
        'discord-open-dm',
        "Couldn't open a DM channel with you.",
        'Make sure the bot is in a server you\'re also in, then retry setup.',
      );
    }
    s.stop(`DM channel ready. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`);
    setupLog.step('discord-open-dm', 'success', Date.now() - start, {
      DM_CHANNEL_ID: data.id,
    });
    return data.id;
  } catch (err) {
    s.stop(`Couldn't reach Discord. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`, 1);
    const message = err instanceof Error ? err.message : String(err);
    setupLog.step('discord-open-dm', 'failed', Date.now() - start, {
      ERROR: message,
    });
    await fail(
      'discord-open-dm',
      "Couldn't reach Discord.",
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
