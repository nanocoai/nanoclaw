/**
 * Credential-mode picker.
 *
 *   - native: built-in credential proxy reads from .env. Simple, no extra
 *     daemon. Best for single-user installs.
 *   - onecli: OneCLI Agent Vault gateway. Encrypted secrets, multi-agent
 *     scoping, web UI. More setup, more features.
 *
 * Persisted to .env as NANOCLAW_CREDENTIAL_MODE. Setup re-reads on
 * subsequent runs and skips the prompt when the value is valid.
 * Set NANOCLAW_SKIP=credential-mode to bypass entirely.
 *
 * Reference: chiptoe-svg/nanoclaw_gccourse main, setup/auto.ts ~L201–237.
 */
import { brightSelect } from './bright-select.js';
import { detectClaudeOAuthToken } from './claude-oauth-detect.js';
import type { OAuthSource } from './claude-oauth-detect.js';

export type CredentialMode = 'native' | 'onecli';

const VALID_MODES: readonly CredentialMode[] = ['native', 'onecli'] as const;

function isValidMode(value: string | undefined): value is CredentialMode {
  return value !== undefined && (VALID_MODES as readonly string[]).includes(value);
}

export async function pickCredentialMode(
  env: NodeJS.ProcessEnv,
  hints?: { oauthSource?: OAuthSource | null },
): Promise<CredentialMode> {
  const fromEnv = env.NANOCLAW_CREDENTIAL_MODE;
  if (isValidMode(fromEnv)) {
    return fromEnv;
  }
  const nativeHint =
    hints?.oauthSource === 'keychain'
      ? 'reads from .env or macOS Keychain — best for solo installs'
      : hints?.oauthSource === 'file'
        ? 'reads from .env or ~/.claude/.credentials.json — best for solo installs'
        : 'reads from .env, no extra daemon — best for solo installs';
  const choice = await brightSelect<CredentialMode>({
    message: 'How would you like to manage provider credentials?',
    options: [
      {
        value: 'native',
        label: 'Native credential proxy (recommended)',
        hint: nativeHint,
      },
      {
        value: 'onecli',
        label: 'OneCLI Agent Vault',
        hint: 'encrypted secrets, per-agent scoping, web UI',
      },
    ],
  });
  // brightSelect returns T | symbol on cancel — coerce here (matches established pattern)
  return choice as CredentialMode;
}

export interface CredentialModeStepResult {
  mode: CredentialMode;
  skipOneCli: boolean;
}

export async function runCredentialModeStep(env: NodeJS.ProcessEnv): Promise<CredentialModeStepResult> {
  const oauthSource = detectClaudeOAuthToken({ HOME: env.HOME, platform: process.platform });
  const mode = await pickCredentialMode(env, { oauthSource });
  return { mode, skipOneCli: mode === 'native' };
}
