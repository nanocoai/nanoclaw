/**
 * The agent runtime the operator picked in THIS setup run, carried to the
 * group-creation child processes over the process boundary.
 *
 * There is no `--provider` flag in the creation contract — provider is a DB
 * property of a group. Setup persists the pick two ways: as the install-wide
 * default (`DEFAULT_AGENT_PROVIDER` in `.env`, see src/config.ts), which every
 * future group inherits at creation via the `ensureContainerConfig` chokepoint;
 * and here, in a setup-run-scoped env var, so the FIRST agent created in the
 * same run (by `init-first-agent` / `init-cli-agent`, which run as child
 * processes) is stamped with the pick before the welcome wakes the container —
 * without waiting for the host to restart and reload `.env`. `undefined` /
 * `'claude'` means no run-scoped pick; the creation scripts then fall back to
 * the install-wide default.
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
