/**
 * scripts/open-a2a-room.ts — open a Slack agent-to-agent (A2A) room.
 *
 * Creates a group DM (MPIM) holding a human plus two or more NanoClaw sibling
 * bots, posts an intro message from the first bot, prints the channel id, and
 * appends it to SLACK_A2A_ROOMS in .env so the slack-a2a-rooms bridge filter
 * starts admitting bot-authored messages there (picked up within ~30s — no
 * service restart required).
 *
 * Usage:
 *   pnpm exec tsx scripts/open-a2a-room.ts --instances <name,name…> [--user <slack user id>]
 *
 * Instance names follow the slack-multi-instance convention: each name reads
 * its bot token from SLACK_BOT_TOKEN_<NAME> (uppercased, dashes →
 * underscores); the special name `default` reads SLACK_BOT_TOKEN. The first
 * listed instance is the caller — it opens the conversation and posts the
 * intro. Bot user ids are resolved via auth.test per token.
 *
 * Requires the `mpim:write` scope on every listed app (see the skill's
 * prerequisites). Without --user the room holds bots only, which needs at
 * least three instances (Slack turns a two-party open into a 1:1 IM).
 *
 * Token values are never printed.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../src/env.js';

const SLACK_API = 'https://slack.com/api';

interface SlackAuth {
  name: string;
  envKey: string;
  token: string;
  userId: string; // U… bot user id (auth.test user_id)
  botId: string | null; // B… bot id (auth.test bot_id)
}

function fail(msg: string): never {
  console.error(`open-a2a-room: ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { instances: string[]; user?: string } {
  let instances: string[] = [];
  let user: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--instances') {
      instances = (argv[++i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (argv[i] === '--user') {
      user = argv[++i];
    } else {
      fail(
        `unknown argument: ${argv[i]}\nUsage: pnpm exec tsx scripts/open-a2a-room.ts --instances <name,name…> [--user <slack user id>]`,
      );
    }
  }
  if (instances.length < 2) fail('--instances needs at least two comma-separated instance names');
  if (!user && instances.length < 3) {
    fail(
      'without --user the room holds bots only, which needs at least three instances (a two-party open becomes a 1:1 IM)',
    );
  }
  if (user && !/^[UW][A-Z0-9]+$/.test(user)) {
    fail(`--user must be a Slack user id (U…/W…), got: ${user}`);
  }
  return { instances, user };
}

function tokenEnvKey(name: string): string {
  if (name === 'default') return 'SLACK_BOT_TOKEN';
  return `SLACK_BOT_TOKEN_${name.toUpperCase().replace(/-/g, '_')}`;
}

async function slackCall(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (json.ok !== true) {
    throw new Error(`${method} failed: ${String(json.error ?? `HTTP ${res.status}`)}`);
  }
  return json;
}

async function resolveAuth(name: string): Promise<SlackAuth> {
  const envKey = tokenEnvKey(name);
  const env = readEnvFile([envKey]);
  const token = env[envKey];
  if (!token) fail(`missing ${envKey} in .env (slack-multi-instance token convention)`);
  const auth = await slackCall(token, 'auth.test', {});
  const userId = typeof auth.user_id === 'string' ? auth.user_id : null;
  if (!userId) fail(`auth.test for instance "${name}" returned no user_id`);
  return {
    name,
    envKey,
    token,
    userId,
    botId: typeof auth.bot_id === 'string' ? auth.bot_id : null,
  };
}

/** Append the room to SLACK_A2A_ROOMS in .env (create the key if absent,
 * no-op if the id is already listed). */
function appendRoomToEnv(roomId: string): 'appended' | 'already-present' | 'created' {
  const envPath = path.join(process.cwd(), '.env');
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    // no .env — create one with just this key
  }
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.trim().startsWith('SLACK_A2A_ROOMS='));
  if (idx === -1) {
    const suffix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(envPath, `${content}${suffix}SLACK_A2A_ROOMS=${roomId}\n`);
    return 'created';
  }
  const existing = lines[idx].slice(lines[idx].indexOf('=') + 1).trim();
  const rooms = existing
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (rooms.includes(roomId)) return 'already-present';
  rooms.push(roomId);
  lines[idx] = `SLACK_A2A_ROOMS=${rooms.join(',')}`;
  fs.writeFileSync(envPath, lines.join('\n'));
  return 'appended';
}

async function main(): Promise<void> {
  const { instances, user } = parseArgs(process.argv.slice(2));

  console.log(`Resolving bot identities for: ${instances.join(', ')}`);
  const auths: SlackAuth[] = [];
  for (const name of instances) {
    const auth = await resolveAuth(name);
    console.log(`  ${name}: bot user ${auth.userId}${auth.botId ? ` (bot id ${auth.botId})` : ''}`);
    auths.push(auth);
  }

  const caller = auths[0];
  const otherBotUserIds = auths.slice(1).map((a) => a.userId);
  const members = [...(user ? [user] : []), ...otherBotUserIds];

  console.log(`Opening group DM as "${caller.name}" with: ${members.join(', ')}`);
  const opened = await slackCall(caller.token, 'conversations.open', {
    users: members.join(','),
  });
  const channel = opened.channel as Record<string, unknown> | undefined;
  const channelId = typeof channel?.id === 'string' ? channel.id : null;
  if (!channelId) fail('conversations.open returned no channel id');
  if (channel?.is_mpim !== true) {
    console.warn(
      `warning: opened conversation ${channelId} is not an MPIM (is_mpim=${String(channel?.is_mpim)}) — with fewer than three members Slack returns a 1:1 IM`,
    );
  }

  const botMentions = otherBotUserIds.map((id) => `<@${id}>`).join(' ');
  const introText =
    `:robot_face: Agent-to-agent room opened by "${caller.name}". ` +
    `${botMentions}${user ? ` <@${user}>` : ''} — bots in this room can hear each other. ` +
    `Conversation is mention-driven: @-mention a bot to get its reply, and it can @-mention the next one. ` +
    `After too many consecutive bot messages the room pauses until a human speaks.`;
  await slackCall(caller.token, 'chat.postMessage', {
    channel: channelId,
    text: introText,
  });

  const envResult = appendRoomToEnv(channelId);
  console.log('');
  console.log(`A2A room channel id: ${channelId}`);
  console.log(
    envResult === 'already-present'
      ? 'SLACK_A2A_ROOMS already lists this room — .env unchanged.'
      : `SLACK_A2A_ROOMS ${envResult === 'created' ? 'created' : 'updated'} in .env — the bridge filter picks it up within ~30s (no restart needed).`,
  );
  console.log('');
  console.log('Next steps (once per room):');
  console.log(`  - Mention a bot in the room once so the host auto-creates the messaging group,`);
  console.log(`    then allow bot senders through the access gate, e.g.:`);
  console.log(
    `      pnpm exec tsx scripts/q.ts data/v2.db "UPDATE messaging_groups SET unknown_sender_policy='public' WHERE platform_id='slack:${channelId}'"`,
  );
  console.log(`    (or approve / add the slack:bot:<bot_id> users as members instead of going public).`);
  console.log(`  - Wire the room to each bot's agent group (ncl messaging-groups / wirings) if not auto-wired.`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
