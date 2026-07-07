/**
 * Native credential proxy — host-side credential injection for users who opt
 * out of the OneCLI gateway and keep Anthropic credentials in `.env`.
 *
 * This is an explicit opt-out of the OneCLI agent vault. Where the gateway
 * injects an HTTPS_PROXY + CA cert so container API calls are routed through
 * the vault for per-request credential injection, this reads the Anthropic
 * credential straight from `.env` and threads it into the container as `-e`
 * environment variables. The Claude Agent SDK in the container reads these
 * standard variables natively, so the credential reaches the API request with
 * no proxy or cert machinery.
 *
 * Tradeoff (the credential inversion): the credential lives in `.env` on the
 * host and is passed into the container env, instead of staying in the OneCLI
 * vault and being injected per request. That is the entire purpose of this
 * skill — simple `.env`-based credentials without OneCLI — so the env-var
 * threading is intentional here, not an accident.
 *
 * Lives in its own file so the reach-in in `container-runner.ts` is a single
 * call (`args.push(...nativeCredentialEnvArgs())`) and this logic is
 * behavior-testable in isolation, without invoking the OneCLI-entangled
 * `buildContainerArgs`. All gating lives here too: when the opt-out flag is
 * not set, the function returns no args and the gateway path is untouched.
 */
import { readEnvFile } from './env.js';

/** Env flag that turns the native `.env` credential opt-out on. */
export const NATIVE_CREDENTIALS_FLAG = 'NANOCLAW_NATIVE_CREDENTIALS';

/**
 * Anthropic credential variables read from `.env`, in the order the Claude
 * Agent SDK resolves them. `ANTHROPIC_BASE_URL` is optional and only forwarded
 * when present (custom endpoints / gateways).
 */
export const NATIVE_CREDENTIAL_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const;

/** Is the native `.env` credential opt-out enabled? */
export function nativeCredentialsEnabled(): boolean {
  return process.env[NATIVE_CREDENTIALS_FLAG] === 'true';
}

/**
 * Build the Docker `-e` arguments that inject the Anthropic credential from
 * `.env` into the container.
 *
 * Returns an empty array (no-op) unless the opt-out flag is set, so the
 * single reach-in in core is safe to call unconditionally. Values are read
 * from `.env` via core's `readEnvFile` (which does not pollute the host
 * process env) and fall back to `process.env` for each variable.
 *
 * At least one of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or
 * `CLAUDE_CODE_OAUTH_TOKEN` must be present, or this throws — refusing to
 * spawn a container with native credentials enabled but none supplied mirrors
 * the gateway's "no credentials, no container" stance.
 */
export function nativeCredentialEnvArgs(): string[] {
  if (!nativeCredentialsEnabled()) return [];

  const fromEnvFile = readEnvFile([...NATIVE_CREDENTIAL_VARS]);
  const resolve = (key: string): string | undefined => process.env[key] || fromEnvFile[key];

  const args: string[] = [];
  let hasCredential = false;
  for (const key of NATIVE_CREDENTIAL_VARS) {
    const value = resolve(key);
    if (!value) continue;
    args.push('-e', `${key}=${value}`);
    if (key !== 'ANTHROPIC_BASE_URL') hasCredential = true;
  }

  if (!hasCredential) {
    throw new Error(
      `${NATIVE_CREDENTIALS_FLAG}=true but no Anthropic credential found in .env — ` +
        'set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN',
    );
  }

  return args;
}
