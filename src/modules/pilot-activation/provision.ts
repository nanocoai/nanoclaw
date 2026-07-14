/**
 * Pilot agent provisioning — everything that happens after a valid START.
 *
 * Binds the agent to the Telegram identity of whoever pressed START (never
 * to the phone/email from the form — those stay as contact metadata on the
 * activation row). Creates: user + membership, agent group (fixed name
 * "ג'ני", folder pilot-tg-<telegram user id>), DM messaging group, wiring,
 * and routes a welcome trigger through the normal inbound path so the
 * fresh container wakes and greets in the registration language.
 */
import { getAgentGroupByFolder, createAgentGroup } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { routeInbound } from '../../router.js';
import { addMember } from '../permissions/db/agent-group-members.js';
import { upsertUser } from '../permissions/db/users.js';
import type { AgentGroup } from '../../types.js';
import { PILOT_WINDOW_DAYS, type PilotActivation, type PilotLang } from './db.js';

/** Fixed display name for every pilot agent — no rename invitation. */
export const PILOT_AGENT_NAME = "ג'ני";

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function pilotFolder(telegramUserId: string): string {
  return `pilot-tg-${telegramUserId}`;
}

function pilotInstructions(lang: PilotLang, pilotEndsAt: string): string {
  const endDate = pilotEndsAt.slice(0, 10);
  if (lang === 'en') {
    return (
      `# ${PILOT_AGENT_NAME} (Jenny)\n\n` +
      `You are Jenny (ג'ני), a personal AI assistant in the Shellano pilot. ` +
      `Always introduce yourself as Jenny — your name is fixed; do not offer to change it.\n\n` +
      `Speak English with this user (their registration language). Keep replies warm, concise, and practical.\n\n` +
      `This is a ${PILOT_WINDOW_DAYS}-day pilot. The pilot window ends on ${endDate}. ` +
      `If asked how long the pilot lasts or when it ends, answer from this date.`
    );
  }
  return (
    `# ${PILOT_AGENT_NAME}\n\n` +
    `את ג'ני, עוזרת AI אישית בפיילוט של Shellano. ` +
    `הציגי את עצמך תמיד בשם ג'ני — השם קבוע; אל תציעי לשנות אותו.\n\n` +
    `דברי עברית עם המשתמש (שפת ההרשמה שלו). שמרי על תשובות חמות, קצרות ופרקטיות.\n\n` +
    `זהו פיילוט של ${PILOT_WINDOW_DAYS} ימים. חלון הפיילוט מסתיים בתאריך ${endDate}. ` +
    `אם שואלים כמה זמן הפיילוט נמשך או מתי הוא מסתיים — עני לפי התאריך הזה.`
  );
}

function welcomeTrigger(lang: PilotLang): string {
  return lang === 'en'
    ? 'System instruction: a new pilot user just activated you via Telegram. Introduce yourself briefly as Jenny, in English, and invite them to tell you what they need help with.'
    : "System instruction: משתמש פיילוט חדש הפעיל אותך הרגע דרך טלגרם. הציגי את עצמך בקצרה בשם ג'ני, בעברית, והזמיני אותו לספר לך במה הוא צריך עזרה.";
}

export interface ProvisionInput {
  /** Raw Telegram user id of whoever pressed START (no channel prefix). */
  telegramUserId: string;
  /** DM platform id, e.g. "telegram:123456" (chat id == user id for DMs). */
  platformId: string;
  /** Display name from the Telegram profile, if known. */
  displayName: string | null;
  lang: PilotLang;
  /** The consumed activation row (pilot_ends_at already stamped). */
  activation: PilotActivation;
}

/**
 * Idempotent per Telegram user: reuses the agent group / messaging group /
 * wiring when they already exist, so a second activation routes to the
 * existing agent instead of creating a duplicate.
 */
export async function provisionPilotAgent(input: ProvisionInput): Promise<AgentGroup> {
  const now = new Date().toISOString();
  const userId = `telegram:${input.telegramUserId}`;

  upsertUser({
    id: userId,
    kind: 'telegram',
    display_name: input.displayName,
    created_at: now,
  });

  const folder = pilotFolder(input.telegramUserId);
  let ag = getAgentGroupByFolder(folder);
  if (!ag) {
    createAgentGroup({
      id: generateId('ag'),
      name: PILOT_AGENT_NAME,
      folder,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(folder)!;
    log.info('Pilot agent group created', { id: ag.id, folder, lang: input.lang });
  }
  initGroupFilesystem(ag, {
    instructions: pilotInstructions(input.lang, input.activation.pilot_ends_at ?? now),
  });

  // Membership only — pilot users are unprivileged (no owner/admin role).
  addMember({ user_id: userId, agent_group_id: ag.id, added_by: null, added_at: now });

  let mg = getMessagingGroupByPlatform('telegram', input.platformId);
  if (!mg) {
    createMessagingGroup({
      id: generateId('mg'),
      channel_type: 'telegram',
      platform_id: input.platformId,
      name: input.displayName ?? `pilot ${input.telegramUserId}`,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    mg = getMessagingGroupByPlatform('telegram', input.platformId)!;
  }

  if (!getMessagingGroupAgentByPair(mg.id, ag.id)) {
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      engage_mode: 'pattern',
      engage_pattern: '.', // DM — respond to everything
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
  }

  // Welcome through the normal inbound path: router writes it into the
  // session's inbound.db and wakes a fresh container (which already runs
  // the current agent-runner code, including idempotent-outbound).
  await routeInbound({
    channelType: 'telegram',
    platformId: input.platformId,
    threadId: null,
    message: {
      id: `pilot-welcome-${Date.now()}`,
      kind: 'chat',
      content: JSON.stringify({
        text: welcomeTrigger(input.lang),
        senderId: userId,
        sender: input.displayName ?? 'pilot user',
      }),
      timestamp: now,
      isGroup: false,
    },
  });

  return ag;
}
