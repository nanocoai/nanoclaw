/**
 * Telegram START handler for pilot activation.
 *
 * The telegram adapter's inbound interceptor calls tryActivatePilot() on
 * every DM text. Non-matching text falls through to normal routing; a
 * matching `/start <code>` is consumed here and never reaches an agent.
 *
 * Cases:
 *  - valid pending code → consume + provision (or reuse) the user's agent
 *  - user already has an active pilot → burn nothing, point at existing agent
 *  - expired / already-used / unknown code → friendly "request a new link"
 */
import { log } from '../../log.js';
import {
  consumeActivation,
  findActivePilotByUser,
  getActivation,
  isExpired,
  looksLikePilotCode,
  type PilotLang,
} from './db.js';
import { provisionPilotAgent, PILOT_AGENT_NAME } from './provision.js';

export interface ActivationInput {
  /** Full message text, e.g. "/start ABCD…". */
  text: string;
  /** DM platform id ("telegram:<chatId>"). */
  platformId: string;
  /** Raw Telegram user id of the sender (no prefix), if known. */
  authorUserId: string | null;
  /** Sender display name, if known. */
  displayName?: string | null;
  /** True when the message came from a group chat — activation is DM-only. */
  isGroup: boolean;
  /** Callback to message the chat directly (bot API), for feedback texts. */
  sendText: (text: string) => Promise<void>;
}

/** Extract a pilot code from "/start <code>" (or a bare pasted code). */
export function extractPilotCode(text: string): string | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/start\s+(\S+)$/) ?? trimmed.match(/^(\S+)$/);
  if (!m) return null;
  return looksLikePilotCode(m[1]) ? m[1] : null;
}

const FEEDBACK = {
  expired: {
    he: 'הקישור הזה פג תוקף (קודים תקפים ל-24 שעות). אפשר לבקש קישור חדש בטופס ההרשמה באתר ונשלח לך אחד מיד. 🙂',
    en: "This link has expired (codes are valid for 24 hours). Request a new link from the signup form on the site and we'll send you one right away. 🙂",
  },
  alreadyUsed: {
    he: 'הקוד הזה כבר נוצל. אם זה לא היית אתה — בקש קישור חדש בטופס ההרשמה באתר.',
    en: "This code has already been used. If that wasn't you — request a new link from the signup form on the site.",
  },
  unknown: {
    he: 'הקוד הזה לא מוכר. בקש קישור חדש בטופס ההרשמה באתר.',
    en: "This code isn't recognized. Please request a new link from the signup form on the site.",
  },
  alreadyActive: {
    he: `הסוכנת שלך ${PILOT_AGENT_NAME} כבר פעילה כאן — אפשר פשוט להמשיך לדבר איתה 🙂`,
    en: `Your agent ${PILOT_AGENT_NAME} is already active here — just keep chatting 🙂`,
  },
} as const;

function feedback(key: keyof typeof FEEDBACK, lang: PilotLang): string {
  return FEEDBACK[key][lang];
}

/**
 * Returns true when the message was an activation attempt and was fully
 * handled here (the caller must short-circuit); false to fall through to
 * normal routing.
 */
export async function tryActivatePilot(input: ActivationInput): Promise<boolean> {
  const code = extractPilotCode(input.text);
  if (!code) return false;

  // A code pasted into a group chat is ignored (activation binds a personal
  // DM). Still counts as handled so the raw code never reaches an agent.
  if (input.isGroup) {
    log.warn('Pilot activation attempted from a group chat — ignored', { platformId: input.platformId });
    return true;
  }

  const activation = getActivation(code);
  const lang: PilotLang = activation?.lang === 'en' ? 'en' : 'he';

  if (!input.authorUserId) {
    log.warn('Pilot activation without resolvable sender id — ignored', { platformId: input.platformId });
    await input.sendText(feedback('unknown', lang));
    return true;
  }
  const userId = `telegram:${input.authorUserId}`;

  // One active agent per Telegram user: a returning user gets routed to
  // their existing agent, regardless of the new code's validity.
  const existing = findActivePilotByUser(userId);
  if (existing?.agent_group_id) {
    log.info('Pilot re-activation — routing to existing agent', { userId, agentGroupId: existing.agent_group_id });
    await input.sendText(feedback('alreadyActive', lang));
    return true;
  }

  if (!activation) {
    await input.sendText(feedback('unknown', lang));
    return true;
  }
  if (activation.status === 'used') {
    await input.sendText(feedback('alreadyUsed', lang));
    return true;
  }
  if (isExpired(activation)) {
    await input.sendText(feedback('expired', lang));
    return true;
  }

  // Consume first (atomic, one-shot) — provisioning happens only for the
  // press that actually won the code.
  const provisionalGroupId = `pending-${Date.now()}`;
  const consumed = consumeActivation(code, { userId, agentGroupId: provisionalGroupId });
  if (!consumed) {
    // Lost a race with a concurrent press of the same link.
    await input.sendText(feedback('alreadyUsed', lang));
    return true;
  }

  try {
    const ag = await provisionPilotAgent({
      telegramUserId: input.authorUserId,
      platformId: input.platformId,
      displayName: input.displayName ?? null,
      lang: consumed.lang,
      activation: consumed,
    });
    // Replace the placeholder with the real agent group id.
    const { getDb } = await import('../../db/connection.js');
    getDb().prepare('UPDATE pilot_activations SET agent_group_id = ? WHERE code = ?').run(ag.id, code);
    log.info('Pilot activated', { userId, agentGroupId: ag.id, lang: consumed.lang, code });
  } catch (err) {
    log.error('Pilot provisioning failed after code consume', { userId, code, err });
    await input.sendText(
      consumed.lang === 'en'
        ? 'Something went wrong setting up your agent — please try the link again in a minute.'
        : 'משהו השתבש בהקמת הסוכנת — נסה ללחוץ על הקישור שוב בעוד דקה.',
    );
    // Re-open the code so a retry press can succeed.
    const { getDb } = await import('../../db/connection.js');
    getDb()
      .prepare(
        `UPDATE pilot_activations
         SET status = 'pending', used_by_user_id = NULL, used_at = NULL,
             agent_group_id = NULL, pilot_started_at = NULL, pilot_ends_at = NULL
         WHERE code = ?`,
      )
      .run(code);
  }
  return true;
}
