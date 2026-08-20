/**
 * Per-group model endpoint → container env.
 *
 * `container_configs.base_url` says WHERE one agent group's inference goes.
 * This module is the single place that maps that intent onto the env the
 * selected provider's client actually reads, so composition never has to know
 * a provider's variable names and a second provider is a case here, not a
 * change at the seam.
 *
 * Only the built-in `claude` provider is mapped today. The Claude Agent SDK
 * reads `ANTHROPIC_BASE_URL`, and the same three variables the optional
 * install-global registration in `./claude.ts` sets are what a per-group
 * endpoint needs. Providers installed from the `providers` branch configure
 * their endpoint through their own surface (opencode: its config + `OPENCODE_*`;
 * codex: `config.toml`), so a base URL means nothing here for them — the ncl
 * write path refuses to set one rather than let it silently do nothing
 * (`endpointOverrideSupported`).
 *
 * Why the contributed lane. `ANTHROPIC_AUTH_TOKEN` is a credential-NAMED key,
 * which `validateSpec` refuses on `ContainerSpec.env` outright; the contributed
 * lane is the sanctioned channel for exactly this (a placeholder bearer a
 * gateway may overwrite on the wire). See src/drivers/types.ts.
 */

/** Providers whose endpoint this seam knows how to express as env. */
const SUPPORTED_PROVIDERS = new Set(['claude']);

/** Hostnames that cannot leave the machine, so bypassing an egress proxy is safe. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

export function endpointOverrideSupported(provider: string | null | undefined): boolean {
  return SUPPORTED_PROVIDERS.has((provider ?? 'claude').toLowerCase() || 'claude');
}

/**
 * Merge a proxy-bypass host into an existing NO_PROXY value instead of
 * replacing it: the gateway's own NO_PROXY (whatever it exempts) has to
 * survive, or bypassing the proxy for Ollama would quietly re-proxy
 * everything the gateway had exempted.
 */
export function mergeNoProxy(existing: string | undefined, host: string): string {
  const entries = (existing ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.some((entry) => entry.toLowerCase() === host.toLowerCase())) entries.push(host);
  return entries.join(',');
}

/**
 * The env a per-group endpoint override contributes, given the env already
 * composed for the container (used only to extend `NO_PROXY`, never to
 * override anything else). Returns an empty record for a provider this seam
 * does not map.
 *
 * A local endpoint additionally gets the proxy bypass: the OneCLI gateway's
 * `HTTP_PROXY`/`HTTPS_PROXY` point at a credential-injecting proxy that has no
 * business in front of a daemon on the same machine (and, for an http://
 * loopback URL, cannot serve it at all). A remote HTTPS endpoint deliberately
 * keeps the proxy, because that is how its real credential gets attached
 * without ever entering the container.
 */
export function endpointEnvFor(
  provider: string | null | undefined,
  baseUrl: string,
  existingEnv: Record<string, string> = {},
): Record<string, string> {
  if (!endpointOverrideSupported(provider)) return {};

  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    // The SDK needs *a* credential to send an Authorization header at all.
    // Ollama ignores it; a gateway-fronted endpoint has the proxy overwrite it.
    // Same literal the install-global registration uses, so both paths look
    // identical on the wire.
    ANTHROPIC_AUTH_TOKEN: 'placeholder',
  };

  const hostname = hostnameOf(baseUrl);
  if (hostname && LOCAL_HOSTS.has(hostname)) {
    // Both spellings: the SDK's HTTP stack reads the uppercase form, most unix
    // tooling in the container reads the lowercase one, and a proxy honored by
    // only one of the two is the failure the old skill's troubleshooting
    // section was really describing.
    env.NO_PROXY = mergeNoProxy(existingEnv.NO_PROXY, hostname);
    env.no_proxy = mergeNoProxy(existingEnv.no_proxy, hostname);
  }
  return env;
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unparseable URL simply gets no bypass
  } catch {
    return undefined;
  }
}
