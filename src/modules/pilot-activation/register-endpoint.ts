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
