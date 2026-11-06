/**
 * OneCLI hands agents the proxy in its GATEWAY_BASE_URL, which in 1.45
 * defaults to host.docker.internal:10255: the agent's own machine. For a
 * gateway on another host that is a port nothing serves, so every model call
 * hangs with no reply until the gateway host sets its own address.
 */
import { readEnvFile } from '../../../../src/env.js';

/** The proxy a gateway hands its default agent, or null when it can't be read. */
export async function advertisedProxy(
  gatewayUrl: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<URL | null> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (process.env.ONECLI_PROJECT_ID) headers['X-Project-Id'] = process.env.ONECLI_PROJECT_ID;
  try {
    // Named: without agent= OneCLI creates a default agent when none exists.
    const url = `${gatewayUrl.replace(/\/+$/, '')}/v1/container-config?agent=default`;
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const env = ((await res.json()) as { env?: Record<string, unknown> } | null)?.env;
    const raw = env?.HTTPS_PROXY ?? env?.HTTP_PROXY;
    return typeof raw === 'string' ? new URL(raw) : null;
  } catch {
    return null;
  }
}

/** Loopback, localhost or a wildcard address: whoever uses it reaches its own machine. */
function ownMachine(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host === '::' ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    /^::ffff:7f[0-9a-f]{2}:/.test(host)
  );
}

/**
 * The warning, with the line to set, when a remote gateway hands agents
 * host.docker.internal or another address of their own machine; else null.
 * A gateway URL on this machine is local, so host.docker.internal is right.
 * Host and port only: the proxy URL carries the agent's token.
 */
export function remoteProxyHint(gatewayUrl: string, proxy: URL | null): string | null {
  if (!proxy || ownMachine(new URL(gatewayUrl).hostname)) return null;
  const host = proxy.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host !== 'host.docker.internal' && !ownMachine(host)) return null;
  const port = proxy.port || (proxy.protocol === 'https:' ? '443' : '80');
  return (
    `The remote OneCLI gateway tells agents to use the proxy ${host}:${port}, their own machine, so model calls ` +
    `will hang with no reply. On the gateway host, set GATEWAY_BASE_URL=${new URL(gatewayUrl).hostname}:${port} ` +
    `in ~/.onecli/.env (with your ONECLI_GATEWAY_PORT in place of ${port} if you set one) and recreate the onecli ` +
    'container: see "Remote gateway" in docs/onecli-upgrades.md.'
  );
}

/**
 * The skill's check after setup, as JSON for its capture: a warning only when
 * setup was pointed at a remote gateway. Never throws, so it never fails the
 * install. The hint is never empty, so the capture always binds a value.
 */
export async function proxyCheck(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ warn: 'yes' | 'no'; hint: string }> {
  const gatewayUrl = env.NANOCLAW_ONECLI_API_HOST?.trim();
  if (!gatewayUrl) return { warn: 'no', hint: 'none' };
  try {
    // A rerun without the token still has the key setup saved in .env.
    const apiKey =
      env.NANOCLAW_ONECLI_API_TOKEN?.trim() || env.ONECLI_API_KEY || readEnvFile(['ONECLI_API_KEY']).ONECLI_API_KEY;
    const hint = remoteProxyHint(gatewayUrl, await advertisedProxy(gatewayUrl, apiKey, fetchImpl));
    return hint ? { warn: 'yes', hint } : { warn: 'no', hint: 'none' };
  } catch {
    return { warn: 'no', hint: 'none' };
  }
}
