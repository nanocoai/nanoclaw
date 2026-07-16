# 03 — Pilot-Activation Module (local-only, Shellano pilot onboarding)

**Intent.** The Shellano pilot onboards leads via a landing page → Telegram deep-link flow.
`POST /api/register` on the shared webhook server mints a one-time 20-char activation code
(24h TTL) and returns `https://t.me/<bot>?start=<CODE>`. When the user presses START in
Telegram, the code is consumed atomically and a personal pilot agent named **ג'ני** (Jenny)
is auto-provisioned: user + membership, agent group `pilot-tg-<telegram-user-id>`, DM
messaging group, wiring, and a welcome trigger routed through the normal inbound path.
One active agent per Telegram user; 10-day pilot window. This module is entirely local —
none of it exists upstream. Reapply it verbatim, with the adaptations listed at the end.

Env knobs (in `.env`): `PILOT_BOT_USERNAME` (pin the bot; else resolved via `getMe` on
`TELEGRAM_BOT_TOKEN`), optional `PILOT_REGISTER_SECRET` (require `x-register-secret` header).

## Files to create (verbatim)

### src/modules/pilot-activation/db.ts

```ts
/**
 * Pilot activation persistence — one row per registration code.
 *
 * Lifecycle: pending → used. Expiry is checked at consume time against
 * `expires_at` (24h from creation); expired codes are never deleted, so
 * the START handler can tell "expired" apart from "never existed" and
 * reply with a friendly "request a new link" instead of silence.
 */
import crypto from 'crypto';

import { getDb } from '../../db/connection.js';

export type PilotLang = 'he' | 'en';

export interface PilotActivation {
  code: string;
  lang: PilotLang;
  /** JSON blob: { name?, email?, phone? } — contact metadata only, never routing. */
  metadata: string | null;
  created_at: string;
  expires_at: string;
  status: 'pending' | 'used';
  used_by_user_id: string | null;
  used_at: string | null;
  agent_group_id: string | null;
  pilot_started_at: string | null;
  pilot_ends_at: string | null;
}

export const CODE_TTL_HOURS = 24;
export const PILOT_WINDOW_DAYS = 10;

/**
 * Codes ride in a t.me deep link (`?start=<code>`), which allows
 * [A-Za-z0-9_-]{1,64}. 20 chars from an unambiguous uppercase alphabet
 * (no 0/O/1/I) ≈ 100 bits — unguessable, and visually distinct from the
 * 4-digit setup pairing codes so the two interceptors never collide.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 20;

export function generatePilotCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

/** Matches text that could be a pilot code (used to cheaply gate the interceptor). */
export function looksLikePilotCode(candidate: string): boolean {
  return new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(candidate);
}

export function createActivation(input: {
  lang: PilotLang;
  metadata?: Record<string, unknown> | null;
}): PilotActivation {
  const now = new Date();
  const expires = new Date(now.getTime() + CODE_TTL_HOURS * 3600 * 1000);
  const row: PilotActivation = {
    code: generatePilotCode(),
    lang: input.lang,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    status: 'pending',
    used_by_user_id: null,
    used_at: null,
    agent_group_id: null,
    pilot_started_at: null,
    pilot_ends_at: null,
  };
  getDb()
    .prepare(
      `INSERT INTO pilot_activations (code, lang, metadata, created_at, expires_at, status)
       VALUES (@code, @lang, @metadata, @created_at, @expires_at, @status)`,
    )
    .run(row as unknown as Record<string, unknown>);
  return row;
}

export function getActivation(code: string): PilotActivation | undefined {
  return getDb().prepare('SELECT * FROM pilot_activations WHERE code = ?').get(code) as PilotActivation | undefined;
}

export function isExpired(activation: PilotActivation, now = new Date()): boolean {
  return now.toISOString() > activation.expires_at;
}

/**
 * Atomically consume a pending, unexpired code. Returns the row when this
 * call did the consuming; null when the code was already used, expired, or
 * unknown (callers then inspect getActivation for the friendly-error path).
 * The single UPDATE with status guard makes concurrent START presses safe.
 */
export function consumeActivation(
  code: string,
  usedBy: { userId: string; agentGroupId: string },
): PilotActivation | null {
  const now = new Date();
  const pilotEnds = new Date(now.getTime() + PILOT_WINDOW_DAYS * 24 * 3600 * 1000);
  const result = getDb()
    .prepare(
      `UPDATE pilot_activations
       SET status = 'used', used_by_user_id = @userId, used_at = @usedAt,
           agent_group_id = @agentGroupId, pilot_started_at = @usedAt, pilot_ends_at = @pilotEnds
       WHERE code = @code AND status = 'pending' AND expires_at > @usedAt`,
    )
    .run({
      code,
      userId: usedBy.userId,
      agentGroupId: usedBy.agentGroupId,
      usedAt: now.toISOString(),
      pilotEnds: pilotEnds.toISOString(),
    });
  if (result.changes === 0) return null;
  return getActivation(code)!;
}

/**
 * The user's current active pilot, if any — enforces "one active agent per
 * Telegram user". Active = consumed and still inside the 10-day window.
 */
export function findActivePilotByUser(userId: string): PilotActivation | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM pilot_activations
       WHERE used_by_user_id = ? AND status = 'used' AND pilot_ends_at > ?
       ORDER BY used_at DESC LIMIT 1`,
    )
    .get(userId, new Date().toISOString()) as PilotActivation | undefined;
}
```

### src/modules/pilot-activation/provision.ts

```ts
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
```

### src/modules/pilot-activation/activation.ts

```ts
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
```

### src/modules/pilot-activation/register-endpoint.ts

```ts
/**
 * POST /api/register — pilot lead registration.
 *
 * The landing page posts { name, email, phone, lang } here. We mint a
 * one-time activation code (24h TTL) and return a Telegram deep link:
 *   { status: "live", deepLink: "https://t.me/<bot>?start=<CODE>" }
 *
 * Phone and email are stored as contact metadata on the activation row —
 * they are never used for routing; the agent binds to whoever presses
 * START in Telegram.
 *
 * Bot username resolution: PILOT_BOT_USERNAME env override first (lets the
 * pilot host pin "Nanoco_pilot_bot" explicitly), then Telegram getMe on
 * TELEGRAM_BOT_TOKEN, cached after first success.
 *
 * Optional auth: when PILOT_REGISTER_SECRET is set in .env, requests must
 * carry it in the `x-register-secret` header.
 */
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { createActivation, type PilotLang } from './db.js';

let cachedBotUsername: string | null = null;

async function resolveBotUsername(): Promise<string | null> {
  if (cachedBotUsername) return cachedBotUsername;
  const env = readEnvFile(['PILOT_BOT_USERNAME', 'TELEGRAM_BOT_TOKEN']);
  if (env.PILOT_BOT_USERNAME) {
    cachedBotUsername = env.PILOT_BOT_USERNAME.replace(/^@/, '');
    return cachedBotUsername;
  }
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
    if (json.ok && json.result?.username) {
      cachedBotUsername = json.result.username;
      return cachedBotUsername;
    }
  } catch (err) {
    log.warn('Pilot register: getMe failed', { err });
  }
  return null;
}

interface RegisterBody {
  name?: string;
  email?: string;
  phone?: string;
  lang?: string;
}

export async function handleRegister(req: Request): Promise<Response> {
  const env = readEnvFile(['PILOT_REGISTER_SECRET']);
  if (env.PILOT_REGISTER_SECRET && req.headers.get('x-register-secret') !== env.PILOT_REGISTER_SECRET) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: RegisterBody;
  try {
    body = (await req.json()) as RegisterBody;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const lang: PilotLang = body.lang === 'en' ? 'en' : 'he';
  const botUsername = await resolveBotUsername();
  if (!botUsername) {
    log.error('Pilot register: no bot username available (set PILOT_BOT_USERNAME or TELEGRAM_BOT_TOKEN)');
    return Response.json({ status: 'pending', error: 'bot_unavailable' }, { status: 503 });
  }

  const activation = createActivation({
    lang,
    metadata: {
      name: body.name ?? null,
      email: body.email ?? null,
      phone: body.phone ?? null,
    },
  });

  log.info('Pilot registration created', { code: activation.code, lang });
  return Response.json({
    status: 'live',
    deepLink: `https://t.me/${botUsername}?start=${activation.code}`,
    expiresAt: activation.expires_at,
  });
}
```

### src/modules/pilot-activation/index.ts

```ts
/**
 * Pilot activation module — shellano pilot onboarding via Telegram.
 *
 * Registers POST /api/register on the shared HTTP server. The Telegram
 * adapter imports tryActivatePilot directly for the START interceptor.
 */
import { registerHttpRoute } from '../../webhook-server.js';
import { handleRegister } from './register-endpoint.js';

export { tryActivatePilot } from './activation.js';

registerHttpRoute('POST', '/api/register', handleRegister);
```

### src/modules/pilot-activation/pilot-activation.test.ts

```ts
/**
 * Tests for pilot activation: code lifecycle (create → consume → burn),
 * 24h expiry, one-active-agent-per-user, and the START handler's feedback
 * paths. The happy provisioning path (agent group + wiring + welcome) runs
 * against live infra and is verified in the live smoke test, not here.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import {
  createActivation,
  consumeActivation,
  findActivePilotByUser,
  generatePilotCode,
  getActivation,
  isExpired,
  looksLikePilotCode,
} from './db.js';
import { extractPilotCode, tryActivatePilot } from './activation.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('pilot codes', () => {
  it('generates 20-char codes that pass their own format check', () => {
    const code = generatePilotCode();
    expect(code).toHaveLength(20);
    expect(looksLikePilotCode(code)).toBe(true);
  });

  it('does not mistake 4-digit pairing codes for pilot codes', () => {
    expect(looksLikePilotCode('1234')).toBe(false);
  });

  it('creates a pending activation with a 24h expiry', () => {
    const a = createActivation({ lang: 'he', metadata: { email: 'x@y.z' } });
    expect(a.status).toBe('pending');
    const hours = (Date.parse(a.expires_at) - Date.parse(a.created_at)) / 3600_000;
    expect(hours).toBeCloseTo(24, 1);
  });

  it('consume burns the code and stamps a 10-day pilot window', () => {
    const a = createActivation({ lang: 'he' });
    const consumed = consumeActivation(a.code, { userId: 'telegram:111', agentGroupId: 'ag-1' });
    expect(consumed?.status).toBe('used');
    expect(consumed?.used_by_user_id).toBe('telegram:111');
    const days = (Date.parse(consumed!.pilot_ends_at!) - Date.parse(consumed!.pilot_started_at!)) / 86_400_000;
    expect(days).toBeCloseTo(10, 1);

    // Second consume of the same code loses.
    expect(consumeActivation(a.code, { userId: 'telegram:222', agentGroupId: 'ag-2' })).toBeNull();
  });

  it('refuses to consume an expired code', () => {
    const a = createActivation({ lang: 'en' });
    getDb()
      .prepare('UPDATE pilot_activations SET expires_at = ? WHERE code = ?')
      .run(new Date(Date.now() - 1000).toISOString(), a.code);
    expect(isExpired(getActivation(a.code)!)).toBe(true);
    expect(consumeActivation(a.code, { userId: 'telegram:111', agentGroupId: 'ag-1' })).toBeNull();
  });

  it('findActivePilotByUser sees only in-window pilots', () => {
    const a = createActivation({ lang: 'he' });
    consumeActivation(a.code, { userId: 'telegram:111', agentGroupId: 'ag-1' });
    expect(findActivePilotByUser('telegram:111')?.code).toBe(a.code);
    expect(findActivePilotByUser('telegram:999')).toBeUndefined();

    // Push the window into the past — no longer active.
    getDb()
      .prepare('UPDATE pilot_activations SET pilot_ends_at = ? WHERE code = ?')
      .run(new Date(Date.now() - 1000).toISOString(), a.code);
    expect(findActivePilotByUser('telegram:111')).toBeUndefined();
  });
});

describe('extractPilotCode', () => {
  it('extracts from /start deep-link payloads and bare pastes', () => {
    const code = generatePilotCode();
    expect(extractPilotCode(`/start ${code}`)).toBe(code);
    expect(extractPilotCode(code)).toBe(code);
    expect(extractPilotCode(`  /start ${code}  `)).toBe(code);
  });

  it('returns null for chatter, pairing codes, and malformed starts', () => {
    expect(extractPilotCode('hello there')).toBeNull();
    expect(extractPilotCode('/start')).toBeNull();
    expect(extractPilotCode('/start 1234')).toBeNull();
    expect(extractPilotCode('1234')).toBeNull();
  });
});

describe('tryActivatePilot — feedback paths', () => {
  function makeInput(text: string, overrides: Record<string, unknown> = {}) {
    const sent: string[] = [];
    return {
      sent,
      input: {
        text,
        platformId: 'telegram:111',
        authorUserId: '111',
        displayName: 'Test User',
        isGroup: false,
        sendText: async (t: string) => {
          sent.push(t);
        },
        ...overrides,
      },
    };
  }

  it('falls through (false) on non-code text', async () => {
    const { input } = makeInput('sup');
    expect(await tryActivatePilot(input)).toBe(false);
  });

  it('unknown code → friendly request-new-link message', async () => {
    const { input, sent } = makeInput(`/start ${generatePilotCode()}`);
    expect(await tryActivatePilot(input)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('לא מוכר');
  });

  it('expired code → friendly expiry message in the code language', async () => {
    const a = createActivation({ lang: 'en' });
    getDb()
      .prepare('UPDATE pilot_activations SET expires_at = ? WHERE code = ?')
      .run(new Date(Date.now() - 1000).toISOString(), a.code);
    const { input, sent } = makeInput(`/start ${a.code}`);
    expect(await tryActivatePilot(input)).toBe(true);
    expect(sent[0]).toContain('expired');
  });

  it('used code (by someone else) → already-used message', async () => {
    const a = createActivation({ lang: 'he' });
    consumeActivation(a.code, { userId: 'telegram:999', agentGroupId: 'ag-x' });
    const { input, sent } = makeInput(`/start ${a.code}`);
    expect(await tryActivatePilot(input)).toBe(true);
    expect(sent[0]).toContain('כבר נוצל');
  });

  it('user with an active pilot → routed to existing agent, new code NOT burned', async () => {
    const first = createActivation({ lang: 'he' });
    consumeActivation(first.code, { userId: 'telegram:111', agentGroupId: 'ag-1' });

    const second = createActivation({ lang: 'he' });
    const { input, sent } = makeInput(`/start ${second.code}`);
    expect(await tryActivatePilot(input)).toBe(true);
    expect(sent[0]).toContain('כבר פעילה');
    expect(getActivation(second.code)?.status).toBe('pending'); // untouched
  });

  it('group chats are ignored (handled, no provisioning, no reply)', async () => {
    const a = createActivation({ lang: 'he' });
    const { input, sent } = makeInput(`/start ${a.code}`, { isGroup: true });
    expect(await tryActivatePilot(input)).toBe(true);
    expect(sent).toHaveLength(0);
    expect(getActivation(a.code)?.status).toBe('pending');
  });
});
```

## Migration (⚠️ RENUMBER — collision with upstream)

Locally this was `src/db/migrations/016-pilot-activations.ts` with `version: 16`. Upstream
`origin/main` now already has `016-messaging-group-instance.ts`, `017-agent-message-policies.ts`,
`018-approvals-approver-user-id.ts`, `019-wiring-threads.ts`. **Create this as
`020-pilot-activations.ts` with `version: 20`** (or the next free number if upstream moved
further — check `git ls-tree origin/main src/db/migrations/` first), and register it in
`src/db/migrations/index.ts` (import + append to the `migrations` array). Note the
quota-fallback guide's `017-fallback-provider` migration must also be renumbered (→ 021)
and ordered consistently.

**schema_version reconciliation on the live DB:** the existing `data/v2.db` already has the
`pilot_activations` table and a `schema_version` reflecting local numbering (16/17 applied).
Upstream migrations 16–19 will NOT have run on it. After switching to the clean checkout,
the migration runner will attempt upstream 016–019 (fine — they're new to this DB) and then
the renumbered 020 (its `CREATE TABLE IF NOT EXISTS` makes re-running safe). Verify how the
runner tracks applied versions (`schema_version` table vs per-migration rows) and confirm
016–019 actually apply on the live DB; if the runner uses a single monotonically-increasing
version number and the DB already reads 17, upstream 016–017 would be skipped — in that case
manually apply their SQL or bump numbering accordingly. **This must be checked by hand.**

Migration body (adjust `version` and export name to the new number):

```ts
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Pilot activation codes — the shellano pilot's Telegram-first onboarding.
 *
 * POST /api/register creates a row (status='pending') and hands the lead a
 * t.me deep link. When the user presses START in Telegram, the code is
 * consumed (status='used') and the agent binds to the presser's Telegram
 * identity. Phone/email from the form live in `metadata` — contact info
 * only, never a routing key.
 */
export const migration020: Migration = {
  version: 20,
  name: 'pilot-activations',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pilot_activations (
        code            TEXT PRIMARY KEY,
        lang            TEXT NOT NULL DEFAULT 'he',
        metadata        TEXT,
        created_at      TEXT NOT NULL,
        expires_at      TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        used_by_user_id TEXT,
        used_at         TEXT,
        agent_group_id  TEXT,
        pilot_started_at TEXT,
        pilot_ends_at   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pilot_activations_user ON pilot_activations(used_by_user_id);
    `);
  },
};
```

## Module registration

Append to `src/modules/index.ts`:

```ts
import './pilot-activation/index.js';
```

## webhook-server.ts changes (generic HTTP route registry)

Local addition to `src/webhook-server.ts` — a generic route map alongside the webhook
adapter routes. Reapply these three pieces (check whether upstream restructured
webhook-server; upstream now has a per-instance webhook route registry, so integrate the
same idea into whatever the current shape is — the essentials are: a `Map` keyed
`"METHOD /path"`, a register function that also calls `ensureServer()`, and a dispatch
check at the top of the request handler, before webhook matching, using the path without
query string):

```ts
/**
 * Generic HTTP routes (non-webhook), keyed "METHOD /path". Modules register
 * handlers via registerHttpRoute — e.g. the pilot-activation module's
 * POST /api/register. Handlers use the Web Request/Response API.
 */
type HttpRouteHandler = (req: Request) => Promise<Response>;
const httpRoutes = new Map<string, HttpRouteHandler>();

/**
 * Register a plain HTTP route on the shared server (starts it if needed).
 * Path must be exact (no params); method is uppercased.
 */
export function registerHttpRoute(method: string, path: string, handler: HttpRouteHandler): void {
  httpRoutes.set(`${method.toUpperCase()} ${path}`, handler);
  ensureServer();
  log.info('HTTP route registered', { method: method.toUpperCase(), path });
}
```

Inside `ensureServer()`'s request handler, before the `/webhook/{adapterName}` match:

```ts
    // Generic registered routes take precedence (exact path, no query).
    const pathOnly = url.split('?')[0];
    const httpHandler = httpRoutes.get(`${(req.method || 'GET').toUpperCase()} ${pathOnly}`);
    if (httpHandler) {
      try {
        const webReq = await toWebRequest(req);
        const webRes = await httpHandler(webReq);
        await fromWebResponse(webRes, res);
      } catch (err) {
        log.error('HTTP route handler error', { url: req.url, err });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      }
      return;
    }
```

(`toWebRequest` / `fromWebResponse` already exist in the file for webhook adapters; reuse them.)

## ⚠️ Adaptation notes for origin/main

1. **`initGroupFilesystem` persona seeding — GOOD NEWS, same signature.** Verified against
   `git show origin/main:src/group-init.ts`: upstream is
   `initGroupFilesystem(group, opts?: { instructions?: string; provider?: string | null })`
   and stages `opts.instructions` via `stageGroupPersona(groupDir, opts.instructions)` into
   **`instructions.prepend.md`** (write-once) instead of the local `CLAUDE.local.md`.
   `provision.ts`'s call `initGroupFilesystem(ag, { instructions: pilotInstructions(...) })`
   compiles unchanged; the persona simply lands in `groups/pilot-tg-<id>/instructions.prepend.md`.
   Optionally pass `provider: null` explicitly (upstream default resolution applies). No
   further change needed — but confirm `stageGroupPersona` is write-once-only so a second
   activation doesn't clobber (it is, at time of writing).
2. **DB helper signatures may have drifted.** `createMessagingGroupAgent` fields
   (`engage_mode`/`engage_pattern`/`sender_scope`/`ignored_message_policy`) and
   `createMessagingGroup` fields must be checked against upstream `src/db/messaging-groups.ts`
   — upstream migrations 016 (messaging-group-instance) and 019 (wiring-threads) added
   columns; new required fields (e.g. an instance id or thread config) may need defaults here.
   Same for `routeInbound`'s input shape in upstream `src/router.ts`.
3. **Telegram interceptor hook** — the `tryActivatePilot` call site lives in the Telegram
   adapter; see `04-channels.md`.
4. Existing pilot groups on disk (`groups/pilot-tg-*` with `CLAUDE.local.md`) keep working;
   only future pilots go through `instructions.prepend.md`.
