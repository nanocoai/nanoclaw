/** A remote OneCLI gateway must hand agents its own address as their proxy, or every model call hangs. */
import { readEnvFile } from '../../../../src/env.js';

/** The proxy a gateway hands its default agent, or null when its answer has none. */
export async function advertisedProxy(
  gatewayUrl: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<URL | null> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (process.env.ONECLI_PROJECT_ID) headers['X-Project-Id'] = process.env.ONECLI_PROJECT_ID;
  // Named: without agent= OneCLI creates a default agent when none exists.
  const url = `${gatewayUrl.replace(/\/+$/, '')}/v1/container-config?agent=default`;
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const env = ((await res.json()) as { env?: Record<string, unknown> } | null)?.env;
  const raw = env?.HTTPS_PROXY ?? env?.HTTP_PROXY;
  return typeof raw === 'string' ? new URL(raw) : null;
}

/** Loopback or localhost: whoever uses it reaches its own machine. */
function ownMachine(hostname: string): boolean {
  return hostname === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

/** The hint naming the line to set, or null; host and port only, as the proxy URL carries the agent's token. */
export function remoteProxyHint(gatewayUrl: string, proxy: URL | null): string | null {
  if (!proxy || ownMachine(new URL(gatewayUrl).hostname)) return null;
  const host = proxy.hostname.toLowerCase();
  if (host !== 'host.docker.internal' && !ownMachine(host)) return null;
  const port = proxy.port || (proxy.protocol === 'https:' ? '443' : '80');
  return (
    `The remote OneCLI gateway tells agents to use the proxy ${host}:${port}, their own machine, so model calls ` +
    `will hang with no reply. On the gateway host, set GATEWAY_BASE_URL=${new URL(gatewayUrl).hostname}:${port} ` +
    `in ~/.onecli/.env (with your ONECLI_GATEWAY_PORT in place of ${port} if you set one) and recreate the onecli ` +
    'container: see "Remote gateway" in docs/onecli-upgrades.md.'
  );
}

/** The skill's check as JSON for its capture: never throws, and the hint is never empty, so the capture binds. */
export async function proxyCheck(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ warn: 'yes' | 'no'; hint: string }> {
  const gatewayUrl = env.NANOCLAW_ONECLI_API_HOST?.trim();
  if (!gatewayUrl) return { warn: 'no', hint: 'none' };
  try {
    const apiKey = readEnvFile(['ONECLI_API_KEY']).ONECLI_API_KEY;
    const hint = remoteProxyHint(gatewayUrl, await advertisedProxy(gatewayUrl, apiKey, fetchImpl));
    return hint ? { warn: 'yes', hint } : { warn: 'no', hint: 'none' };
  } catch {
    return { warn: 'no', hint: 'none' };
  }
}
