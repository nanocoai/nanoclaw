/**
 * The agent runtime the operator picked in THIS setup run.
 *
 * There is no install-wide default provider and no `--provider` in the
 * creation contract — provider is a DB property of a group. Setup is the one
 * orchestrator that knows the operator's pick, so it stashes it here (set once
 * at the auth step). The group-creation scripts (`init-first-agent`,
 * `init-cli-agent`) run as **child processes**, so the pick is carried over the
 * process boundary via an environment variable they inherit; they apply it to
 * the group at creation, before the welcome wakes the container. This is the
 * only place the value lives — a setup-run-scoped global, NOT a persisted
 * install default. `undefined` / `'claude'` means the built-in default and no
 * provider write at all.
 */
const ENV_KEY = 'NANOCLAW_PICKED_PROVIDER';

export function setPickedProvider(provider: string | undefined): void {
  const normalized = provider?.trim().toLowerCase() || undefined;
  if (normalized && normalized !== 'claude') {
    process.env[ENV_KEY] = normalized;
  } else {
    delete process.env[ENV_KEY];
  }
}

export function getPickedProvider(): string | undefined {
  return process.env[ENV_KEY]?.trim().toLowerCase() || undefined;
}
