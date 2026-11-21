/**
 * Shape checks for a pasted Anthropic credential. A subscription OAuth token
 * starts `sk-ant-oat`; any other `sk-ant-<type>` is an API key (the Console
 * issues api, usr and svc keys, and may add types), except an OAuth refresh
 * token or an Admin API key, neither of which can call models.
 */
const OAUTH_PREFIX = 'sk-ant-oat';
const REFRESH_PREFIX = 'sk-ant-ort';
const ADMIN_PREFIX = 'sk-ant-admin';
const KEY_PREFIX = /^sk-ant-[a-z]+/;

/** A pasted secret with every whitespace character removed, including a terminal's line wrap. */
export function pastedCredential(raw: string | undefined): string {
  return (raw ?? '').replace(/\s+/g, '');
}

export function isAnthropicOAuthToken(value: string): boolean {
  return value.startsWith(OAUTH_PREFIX);
}

/**
 * The paste prompt's message. Nothing sends an `anthropic-workspace-id`
 * header, so a personal or service-account key that spans several workspaces
 * gets HTTP 400 on every request; a single-workspace key needs no header.
 */
export function anthropicCredentialPrompt(kind: 'api' | 'oauth'): string {
  return kind === 'oauth'
    ? 'Paste your OAuth token'
    : 'Paste your API key (a personal or service-account key must be scoped to one workspace)';
}

/**
 * The prompt's error for a pasted value, or `undefined` when it has the right
 * shape. The API-key prompt also takes an OAuth token, since the prompt cannot
 * go back to the menu; the caller stores the value by its prefix.
 */
export function anthropicCredentialError(kind: 'api' | 'oauth', raw: string | undefined): string | undefined {
  const value = pastedCredential(raw);
  if (!value) return 'Required';
  if (kind === 'oauth') return isAnthropicOAuthToken(value) ? undefined : `Must start with ${OAUTH_PREFIX}`;
  if (isAnthropicOAuthToken(value)) return undefined;
  if (value.startsWith(REFRESH_PREFIX)) return 'OAuth refresh tokens cannot call Claude; paste an API key instead';
  if (value.startsWith(ADMIN_PREFIX)) return 'Admin API keys cannot call Claude; paste an API key instead';
  if (!KEY_PREFIX.test(value))
    return 'Must be an Anthropic API key (sk-ant-api…, sk-ant-usr… or sk-ant-svc…) or an OAuth token (sk-ant-oat…)';
  return undefined;
}
