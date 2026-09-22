/**
 * Channel credential provider — the one seam through which a channel adapter
 * instance obtains its credentials at instance start.
 *
 * Trunk ships the `.env` implementation (`EnvFileCredentialProvider`), which
 * reads exactly the keys the Slack and Teams adapters read today —
 * `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`,
 * `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_APP_TENANT_ID`,
 * `TEAMS_APP_TYPE` — with the same per-instance suffix rule the adapters use
 * (`SLACK_BOT_TOKEN_<NAME>`: name uppercased, dashes → underscores). An
 * enterprise overlay installs another provider (e.g. one that releases
 * sealed credentials from a gateway vault) with `setChannelCredentialProvider`;
 * adapters never know where a value came from.
 *
 * Resolution happens when an adapter instance STARTS (its registry factory
 * runs), not at process boot, so a provider swap or a credential rotation
 * takes effect at the next `startChannelAdapter` without a restart.
 *
 * Keys are the credential names of the connection contract (`bot_token`,
 * `signing_secret`, `app_token`, `app_id`, `app_password`, `tenant_id`,
 * `app_type`), never `.env` variable names — the mapping to `.env` lives
 * only in the default provider.
 */
import { readEnvFile } from '../env.js';

/** Resolves one credential for one adapter instance. `undefined` = not available. */
export interface ChannelCredentialProvider {
  get(instance: string, key: string): Promise<string | undefined>;
}

/**
 * Credential keys the trunk adapters ask for, mapped to the `.env` key each
 * one reads in the default (unsuffixed) instance. The key family (`SLACK_`
 * / `TEAMS_`) also tells the default provider which channel type an
 * instance key belongs to, for the suffix rule below.
 */
export const CHANNEL_CREDENTIAL_ENV_KEYS = {
  bot_token: 'SLACK_BOT_TOKEN',
  signing_secret: 'SLACK_SIGNING_SECRET',
  app_token: 'SLACK_APP_TOKEN',
  app_id: 'TEAMS_APP_ID',
  app_password: 'TEAMS_APP_PASSWORD',
  tenant_id: 'TEAMS_APP_TENANT_ID',
  app_type: 'TEAMS_APP_TYPE',
} as const;

export type ChannelCredentialKey = keyof typeof CHANNEL_CREDENTIAL_ENV_KEYS;

/** Env-key suffix for a named instance: uppercased, dashes → underscores (`gh-bot` → `GH_BOT`). */
export function instanceEnvKeySuffix(name: string): string {
  return name.toUpperCase().replace(/-/g, '_');
}

/**
 * The `.env` key that carries `baseKey` for one adapter instance.
 *  - the default instance (registry key === channel type) reads the bare key;
 *  - an env-mode named instance (`<channelType>-<name>`, from
 *    `SLACK_INSTANCES` / `TEAMS_INSTANCES`) reads `<baseKey>_<NAME>`;
 *  - any other instance key (a connection slug such as `acme-hq`) reads
 *    `<baseKey>_<SLUG>` — so an operator can still hand-provision a
 *    spec-registered instance from `.env`.
 */
export function channelInstanceEnvKey(baseKey: string, channelType: string, instance: string): string {
  if (instance === channelType) return baseKey;
  const name = instance.startsWith(`${channelType}-`) ? instance.slice(channelType.length + 1) : instance;
  return `${baseKey}_${instanceEnvKeySuffix(name)}`;
}

/** `.env` key for (instance, credential key), or undefined for a key trunk does not map. */
export function credentialEnvKey(instance: string, key: string): string | undefined {
  const base = (CHANNEL_CREDENTIAL_ENV_KEYS as Record<string, string>)[key];
  if (!base) return undefined;
  const channelType = base.startsWith('SLACK_') ? 'slack' : 'teams';
  return channelInstanceEnvKey(base, channelType, instance);
}

/**
 * Default provider: reads `.env` on every call (the same parser the adapters
 * used directly before this seam existed — nothing is cached, nothing is
 * loaded into process.env). `projectRoot` defaults to the process cwd.
 */
export class EnvFileCredentialProvider implements ChannelCredentialProvider {
  constructor(private readonly projectRoot?: string) {}

  async get(instance: string, key: string): Promise<string | undefined> {
    const envKey = credentialEnvKey(instance, key);
    if (!envKey) return undefined;
    return readEnvFile([envKey], this.projectRoot)[envKey];
  }
}

let provider: ChannelCredentialProvider = new EnvFileCredentialProvider();

/**
 * Install the process-wide provider. Pass `null` to restore the `.env`
 * default. Takes effect for every adapter instance started afterwards.
 */
export function setChannelCredentialProvider(next: ChannelCredentialProvider | null): void {
  provider = next ?? new EnvFileCredentialProvider();
}

export function getChannelCredentialProvider(): ChannelCredentialProvider {
  return provider;
}

/** Convenience: resolve one credential through the installed provider. */
export function getChannelCredential(instance: string, key: string): Promise<string | undefined> {
  return provider.get(instance, key);
}
