/**
 * Container-owned gateway auth and model default for the pi provider.
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
 * syntactically valid JWT carrying the placeholder claim.
 *
 * A credential is not enough on its own: pi otherwise starts on its built-in
 * default provider (Anthropic first), which the gateway usually has no key for.
 * The provider therefore also fills `settings.json` with a `defaultProvider`
 * and `defaultModel` — the model id is looked up from pi's own runtime catalog
 * (`selectGatewayModel`), never hardcoded, so it follows whatever pi version is
 * installed. Operator-authored values are never overwritten.
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

/** The slice of pi's `ModelRuntime` this module needs; structural so tests need no SDK. */
export interface ModelCatalogEntry {
  readonly provider: string;
  readonly id: string;
}

export interface GatewayModelCatalog {
  getModel(providerId: string, modelId: string): ModelCatalogEntry | undefined;
  getModels(providerId?: string): readonly ModelCatalogEntry[];
  getAvailableSnapshot(): readonly ModelCatalogEntry[];
}

export interface PiSettingsInput {
  defaultProvider?: string;
  defaultModel?: string;
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

/**
 * The provider pi should start on: an explicit setting wins, otherwise a single
 * declared provider is unambiguous. Two providers with no explicit choice stay
 * unset so pi keeps its own default rather than us guessing.
 */
export function resolveDefaultProvider(
  providers: readonly string[],
  explicit: string | undefined,
): string | undefined {
  return explicit?.trim() || (providers.length === 1 ? providers[0] : undefined);
}

/**
 * Pick the model pi should start on, from pi's own catalog — nothing here names
 * a model id, so a pi upgrade changes the answer with no code change. An
 * explicit provider/model (settings or `PI_DEFAULT_*`) wins; otherwise the
 * first model the runtime reports as available for the chosen provider, falling
 * back to the provider's catalog order.
 */
export function selectGatewayModel(
  catalog: GatewayModelCatalog,
  providers: readonly string[],
  explicitProvider?: string,
  explicitModel?: string,
): ModelCatalogEntry | undefined {
  const provider = resolveDefaultProvider(providers, explicitProvider);
  if (!provider) return undefined;
  const model = explicitModel?.trim();
  const inCatalog = () => catalog.getModels(provider).find((entry) => entry.provider === provider);
  if (model) return catalog.getModel(provider, model) ?? inCatalog();
  return catalog.getAvailableSnapshot().find((entry) => entry.provider === provider) ?? inCatalog();
}

function readObject(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ...(parsed as Record<string, unknown>) };
  } catch {
    // Missing or unparseable state: pi cannot use it either, so it is replaced
    // rather than preserved. A real config file is valid JSON.
  }
  return {};
}

/** Read pi's operator-facing settings, if any. */
export function readPiSettings(agentDir: string): PiSettingsInput {
  const settings = readObject(path.join(agentDir, 'settings.json'));
  const provider = typeof settings.defaultProvider === 'string' ? settings.defaultProvider : undefined;
  const model = typeof settings.defaultModel === 'string' ? settings.defaultModel : undefined;
  return { ...(provider ? { defaultProvider: provider } : {}), ...(model ? { defaultModel: model } : {}) };
}

/** Atomically replace `agentDir/<name>`, never following a planted symlink. */
function writeJsonAtomic(agentDir: string, name: string, value: Record<string, unknown>): void {
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(agentDir, `.${name}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, path.join(agentDir, name));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Ensure `agentDir/auth.json` carries gateway placeholders. Idempotent; only
 * fills what is absent, so a real login is never overwritten.
 */
export function initializePiGatewayAuth(agentDir: string, options: PiGatewayAuthOptions = {}): void {
  const authPath = path.join(agentDir, 'auth.json');
  const auth = readObject(authPath);
  let changed = false;
  for (const provider of options.providers ?? []) {
    if (auth[provider] !== undefined) continue;
    auth[provider] =
      provider === PI_CHATGPT_PROVIDER_ID
        ? buildChatGptPlaceholderCredential()
        : { type: 'api_key', key: PI_CREDENTIAL_PLACEHOLDER };
    changed = true;
  }
  if (changed) writeJsonAtomic(agentDir, 'auth.json', auth);
}

/** Fill pi's `settings.json` default provider/model, leaving operator values alone. */
export function ensurePiSettings(agentDir: string, input: PiSettingsInput): void {
  const defaultProvider = input.defaultProvider?.trim();
  const defaultModel = input.defaultModel?.trim();
  if (!defaultProvider && !defaultModel) return;
  const settings = readObject(path.join(agentDir, 'settings.json'));
  let changed = false;
  if (defaultProvider && settings.defaultProvider === undefined) {
    settings.defaultProvider = defaultProvider;
    changed = true;
  }
  if (defaultModel && settings.defaultModel === undefined) {
    settings.defaultModel = defaultModel;
    changed = true;
  }
  if (changed) writeJsonAtomic(agentDir, 'settings.json', settings);
}
