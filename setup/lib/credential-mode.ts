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

export type CredentialMode = 'native' | 'onecli';

const VALID_MODES: readonly CredentialMode[] = ['native', 'onecli'] as const;

function isValidMode(value: string | undefined): value is CredentialMode {
  return value !== undefined && (VALID_MODES as readonly string[]).includes(value);
}

export async function pickCredentialMode(env: NodeJS.ProcessEnv): Promise<CredentialMode> {
  const fromEnv = env.NANOCLAW_CREDENTIAL_MODE;
  if (isValidMode(fromEnv)) {
    return fromEnv;
  }
  const choice = await brightSelect<CredentialMode>({
    message: 'How would you like to manage provider credentials?',
    options: [
      {
        value: 'native',
        label: 'Native credential proxy (recommended)',
        hint: 'reads from .env, no extra daemon — best for solo installs',
      },
      {
        value: 'onecli',
        label: 'OneCLI Agent Vault',
        hint: 'encrypted secrets, per-agent scoping, web UI',
      },
    ],
  });
  return choice as CredentialMode;
}
