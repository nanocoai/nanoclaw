/** OneCLI 1.42 writes this fixed id into its ChatGPT login stand-in (account and user id). */
const STUB_ID = 'onecli-managed';
const AUTH_CLAIMS = 'https://api.openai.com/auth';
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;

interface StubAuth {
  auth_mode?: unknown;
  tokens?: { account_id?: unknown; id_token?: unknown };
}

function parse(content: string): StubAuth | undefined {
  try {
    const auth = JSON.parse(content) as StubAuth;
    return auth && typeof auth === 'object' ? auth : undefined;
  } catch {
    return undefined;
  }
}

/** True for a ChatGPT login stand-in that still carries OneCLI's fixed account id. */
export function stubNeedsAccountId(content: string): boolean {
  const auth = parse(content);
  return auth?.auth_mode === 'chatgpt' && auth.tokens?.account_id === STUB_ID;
}

/** Re-encodes the id token's auth claims when `edit` changed them; returns whether it did. */
function editAuthClaims(tokens: { id_token?: unknown }, edit: (claims: Record<string, unknown>) => boolean): boolean {
  const parts = typeof tokens.id_token === 'string' ? tokens.id_token.split('.') : [];
  if (parts.length !== 3) return false;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const authClaims = claims?.[AUTH_CLAIMS];
    if (!authClaims || typeof authClaims !== 'object' || !edit(authClaims)) return false;
    parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url');
    tokens.id_token = parts.join('.');
    return true;
  } catch {
    // Leave an unreadable id token as OneCLI wrote it.
    return false;
  }
}

/**
 * Put the stored login's workspace id into the stand-in. Clients match it
 * against the account's workspace list before any model request. Tokens stay
 * placeholders; the gateway still injects the real ones.
 */
export function withAccountId(content: string, accountId: string): string {
  if (!ACCOUNT_ID.test(accountId) || !stubNeedsAccountId(content)) return content;
  const auth = parse(content)!;
  const tokens = auth.tokens!;
  tokens.account_id = accountId;
  editAuthClaims(tokens, (claims) => {
    if (claims.chatgpt_account_id !== STUB_ID) return false;
    claims.chatgpt_account_id = accountId;
    return true;
  });
  return JSON.stringify(auth, null, 2);
}

/**
 * The stand-in claims a free plan for every login, and clients hide
 * plan-gated tools such as image generation from a free plan. The real plan
 * is not known here, so drop the made-up claim; the backend still checks the
 * plan against the real token the gateway injects.
 */
export function withoutPlanClaim(content: string): string {
  const auth = parse(content);
  if (auth?.auth_mode !== 'chatgpt' || !auth.tokens) return content;
  const dropped = editAuthClaims(auth.tokens, (claims) => {
    if (claims.chatgpt_user_id !== STUB_ID || !('chatgpt_plan_type' in claims)) return false;
    delete claims.chatgpt_plan_type;
    return true;
  });
  return dropped ? JSON.stringify(auth, null, 2) : content;
}

interface SecretSummary {
  type?: unknown;
  metadata?: { authMode?: unknown; accountId?: unknown } | null;
}

/**
 * OneCLI records the workspace id of each stored ChatGPT login as secret
 * metadata. Returns it only when every stored login names the same valid id;
 * which login an agent may use is OneCLI's decision, so never guess between them.
 */
export function storedAccountId(secrets: unknown): { accountId?: string; logins: number } {
  const ids = new Set<string>();
  let logins = 0;
  let unnamed = false;
  for (const secret of Array.isArray(secrets) ? (secrets as SecretSummary[]) : []) {
    if (secret?.type !== 'openai' || secret.metadata?.authMode !== 'oauth') continue;
    logins += 1;
    const accountId = secret.metadata.accountId;
    if (typeof accountId === 'string' && ACCOUNT_ID.test(accountId)) ids.add(accountId);
    else unnamed = true;
  }
  return ids.size === 1 && !unnamed ? { accountId: [...ids][0], logins } : { logins };
}
