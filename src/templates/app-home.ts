/**
 * Slack bot-identity helpers for the App Home surface.
 *
 * The App Home itself — rendering, publishing, connect-status watching — is
 * owned by the governance service, which the host feeds through
 * src/channels/home-events-forward.ts. What lives here is the small piece of
 * bot identity the host itself needs: the deep link to the bot's Home tab
 * that the welcome message points at.
 */
import { readEnvFile } from '../env.js';

function titleCase(app: string): string {
  return app.charAt(0).toUpperCase() + app.slice(1);
}

let cachedBotIdentity: { name: string; teamId: string } | null = null;

/** The default Slack bot's display name + team, from auth.test (cached). */
async function resolveSlackBotIdentity(): Promise<{ name: string; teamId: string } | null> {
  if (cachedBotIdentity) return cachedBotIdentity;
  const token = readEnvFile(['SLACK_BOT_TOKEN']).SLACK_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.json()) as { ok: boolean; user?: string; team_id?: string };
    if (!body.ok || !body.user || !body.team_id) return null;
    cachedBotIdentity = { name: titleCase(body.user), teamId: body.team_id };
    return cachedBotIdentity;
  } catch {
    return null;
  }
}

/** Deep link to this bot's App Home tab. The app id rides inside the app-level
 *  token (xapp-1-<APPID>-…). Null when Socket Mode isn't configured. */
export async function slackAppHomeDeepLink(): Promise<string | null> {
  const appToken = readEnvFile(['SLACK_APP_TOKEN']).SLACK_APP_TOKEN;
  const appId = appToken?.match(/^xapp-\d+-(A[A-Z0-9]+)-/)?.[1];
  if (!appId) return null;
  const identity = await resolveSlackBotIdentity();
  if (!identity) return null;
  return `slack://app?team=${identity.teamId}&id=${appId}&tab=home`;
}
