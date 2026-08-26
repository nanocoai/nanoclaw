/**
 * Setup-side provider registry — the picker and the standalone `provider-auth`
 * step render from this map instead of hardcoding provider names in the setup
 * flow (same capability-not-name rule as the host provider-container registry).
 *
 * `claude` is the built-in default: it has no `runAuth` of its own, which the
 * setup flow reads as "run the standard auth step". A provider payload adds
 * itself by shipping a `setup/providers/<name>.ts` with a top-level
 * `registerSetupProvider(...)` call and appending one import line to the
 * `setup/providers/index.ts` barrel — the same shape as the host and container
 * provider registries, guarded the same way (a barrel-driven registration test).
 */
import type { AssistContext } from '../lib/claude-assist.js'; // type-only — registry stays runtime-dependency-free
import type { SetupDriver } from '../lib/setup-driver.js';

/**
 * Outcome of a provider-owned failure-assist hook:
 *   - 'launched'    — the provider's debugger ran (user may have fixed things).
 *   - 'declined'    — the user said no; do NOT offer another debugger.
 *   - 'unavailable' — the provider's CLI can't be used here; the dispatcher
 *                     falls back to the guarded Claude offer (never install/sign-in).
 */
export type FailureAssistResult = 'launched' | 'declined' | 'unavailable';

export interface SetupProviderEntry {
  value: string;
  label: string;
  hint: string;
  /** Provider-owned auth walk-through (vault-only). Absent → standard auth step. */
  runAuth?: (driver: SetupDriver) => Promise<void>;
  /** The provider-owned auth walk-through emits only SetupDriver semantics in machine mode. */
  supportsStructuredAuth?: true;
  /** Verifies the provider's payload is wired (files, barrels, Dockerfile pin). */
  runInstallCheck?: (driver: SetupDriver) => Promise<void>;
  /** Provider-owned interactive failure debugger. 'unavailable' → dispatcher
   *  falls back to the guarded Claude offer (never install/sign-in). */
  offerFailureAssist?: (ctx: AssistContext, projectRoot: string) => Promise<FailureAssistResult>;
}

const registry = new Map<string, SetupProviderEntry>();

// Audited providers offered for installation when their payload is not
// already present. Provider branches register themselves in the map above.
const INSTALLABLE_PROVIDERS = [
  { value: 'codex', label: 'Codex', hint: 'OpenAI - ChatGPT subscription or API key' },
] as const;

registry.set('claude', {
  value: 'claude',
  label: 'Claude',
  hint: 'default — Anthropic subscription or API key',
});

export function registerSetupProvider(entry: SetupProviderEntry): void {
  if (registry.has(entry.value)) {
    throw new Error(`Setup provider already registered: ${entry.value}`);
  }
  registry.set(entry.value, entry);
}

export function getSetupProvider(name: string): SetupProviderEntry | undefined {
  return registry.get(name.toLowerCase());
}

/** Run one provider-owned auth flow without letting an old terminal-only adapter corrupt NDJSON. */
export async function runSetupProviderAuth(entry: SetupProviderEntry, driver: SetupDriver): Promise<void> {
  if (!entry.runAuth) throw new Error(`Setup provider has no auth flow: ${entry.value}`);
  if (driver.mode === 'ndjson' && entry.supportsStructuredAuth !== true) {
    driver.error(
      'provider_auth_update_required',
      `${entry.label} setup does not support structured authentication yet.`,
      [
        {
          kind: 'manual',
          title: `Update the ${entry.label} provider`,
          instructions: ['Install the matching provider update, then rerun setup.'],
        },
      ],
      'auth',
    );
  }
  await entry.runAuth(driver);
  await entry.runInstallCheck?.(driver);
}

/** Claude (the default) first, then the rest in registration order. */
export function listSetupProviders(): SetupProviderEntry[] {
  return [...registry.values()];
}

/** The shared picker/catalog choices, including provider payloads installable from trunk. */
export function listSetupProviderChoices(): Array<{ value: string; label: string; hint: string }> {
  const installed = listSetupProviders();
  const installedNames = new Set(installed.map((entry) => entry.value));
  return [
    ...installed.map(({ value, label, hint }) => ({ value, label, hint })),
    ...INSTALLABLE_PROVIDERS.filter(({ value }) => !installedNames.has(value)).map((provider) => ({
      ...provider,
      hint: `${provider.hint} - installs now`,
    })),
  ];
}
