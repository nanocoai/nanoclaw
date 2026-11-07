/**
 * Hosts the container must reach WITHOUT the credential gateway. A gateway
 * contribution injects HTTP_PROXY/HTTPS_PROXY pointing at the gateway, and Bun
 * (so Claude Code's MCP client) honours them for plain-http URLs too — but
 * the gateway cannot resolve `host.docker.internal` from inside its own
 * network, so every plain-HTTP MCP server on the host (the documented
 * `parseMcpServerConfig` case) fails with ECONNRESET. Local hops carry no
 * credentials, so nothing is lost by bypassing. Honoured by Bun, Node
 * (NODE_USE_ENV_PROXY), curl and git.
 *
 * Applied in core (`composeSessionSpec`) rather than in a gateway provider,
 * so every installed gateway gets it and no provider has to remember it.
 */
export const LOCAL_PROXY_BYPASS = 'host.docker.internal,localhost,127.0.0.1';

/** Add NO_PROXY/no_proxy for local hops unless a contribution already set one. */
export function withLocalProxyBypass(env: Record<string, string>): Record<string, string> {
  const hasProxy = Object.keys(env).some((k) => /^https?_proxy$/i.test(k));
  if (!hasProxy) return env;
  const out = { ...env };
  if (!('NO_PROXY' in out) && !('no_proxy' in out)) {
    out.NO_PROXY = LOCAL_PROXY_BYPASS;
    out.no_proxy = LOCAL_PROXY_BYPASS;
  }
  return out;
}
