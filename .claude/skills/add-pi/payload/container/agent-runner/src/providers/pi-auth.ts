/**
 * Container-owned gateway auth for the pi provider.
 *
 * pi resolves models and credentials exclusively from its agentDir files and
 * reads no auth from the environment. Following the gateway model, the
 * container never receives a real token: before every session open it writes
 * fixed `gateway-managed` placeholders into `auth.json` for exactly the
 * providers the gateway holds keys for, and the selected gateway replaces them
 * on the wire (by destination host, not by value).
 *
 * The ChatGPT subscription path is special: pi derives the account id from the
 * access token's JWT payload and refuses the request when it cannot, so a bare
 * placeholder string is not enough — `buildPlaceholderAccessToken` emits a
 * syntactically valid JWT carrying the placeholder claim. The real token and
 * account header are injected by the gateway.
 *
 * The provider list arrives host-side as `PI_GATEWAY_PROVIDERS`, so a provider
 * the gateway does not hold gets no entry and pi never selects it. Real logins
 * already written into the group's shared agentDir are never overwritten: the
 * initializer only fills entries that are absent.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

/** Non-secret marker the runtime presents in place of every gateway credential. */
export const PI_CREDENTIAL_PLACEHOLDER = 'gateway-managed';

/** pi's ChatGPT (Codex) subscription provider id — the one built-in OAuth provider the gateway injects. */
export const PI_CHATGPT_PROVIDER_ID = 'openai-codex';

/** pi reads the ChatGPT account id from this JWT claim path (`openai-codex` auth). */
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';

/** Far-future expiry: the placeholder is never refreshed, and pi must not try. */
const PLACEHOLDER_EXPIRES = Date.UTC(2100, 0, 1);

export interface PiGatewayAuthOptions {
  /**
   * pi provider ids whose credentials live in the gateway. `openai-codex` gets
   * an OAuth placeholder; every other id gets an API-key placeholder.
   */
  providers?: readonly string[];
}

function base64(json: unknown): string {
  return Buffer.from(JSON.stringify(json), 'utf-8').toString('base64');
}

/**
 * A syntactically valid, non-secret JWT. pi's `openai-codex` transport decodes
 * the access token to read `chatgpt_account_id`, so the placeholder must carry
 * that claim or the request fails before the gateway can inject anything.
 */
export function buildPlaceholderAccessToken(accountId = PI_CREDENTIAL_PLACEHOLDER): string {
  const header = base64({ alg: 'none', typ: 'JWT' });
  const payload = base64({ [JWT_CLAIM_PATH]: { chatgpt_account_id: accountId } });
  return `${header}.${payload}.${PI_CREDENTIAL_PLACEHOLDER}`;
}

/** pi's canonical OAuth credential shape with every secret-bearing field replaced. */
export function buildChatGptPlaceholderCredential(): Record<string, unknown> {
  return {
    type: 'oauth',
    access: buildPlaceholderAccessToken(),
    refresh: PI_CREDENTIAL_PLACEHOLDER,
    expires: PLACEHOLDER_EXPIRES,
    accountId: PI_CREDENTIAL_PLACEHOLDER,
  };
}

/** Parse the host-provided comma-separated provider list into a de-duped, trimmed list. */
export function parseGatewayProviders(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return [...new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean))];
}

function readAuthObject(authPath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Missing or unparseable state: pi cannot authenticate with it either, so
    // it is replaced rather than preserved. A real login is valid JSON.
  }
  return {};
}

/**
 * Ensure `agentDir/auth.json` carries gateway placeholders for the declared
 * providers. Idempotent, and atomic: a stale file (or a planted symlink) is
 * replaced, never followed.
 */
export function initializePiGatewayAuth(agentDir: string, options: PiGatewayAuthOptions = {}): void {
  const authPath = path.join(agentDir, 'auth.json');
  const auth = readAuthObject(authPath);

  let changed = false;
  for (const provider of options.providers ?? []) {
    if (auth[provider] !== undefined) continue;
    auth[provider] =
      provider === PI_CHATGPT_PROVIDER_ID
        ? buildChatGptPlaceholderCredential()
        : { type: 'api_key', key: PI_CREDENTIAL_PLACEHOLDER };
    changed = true;
  }
  if (!changed) return;

  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(agentDir, `.auth-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    // Replace stale files or symlinks without following or changing their targets.
    fs.renameSync(temporary, authPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
