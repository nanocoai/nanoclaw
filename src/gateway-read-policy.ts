import { envValue } from './env.js';

/** Operator-selected destinations only; never infer read safety for arbitrary sites. */
export function permitsConfiguredGatewayRead(destination: { host: string; method?: string }): boolean {
  if (destination.method !== 'GET' && destination.method !== 'HEAD') return false;
  const configured = process.env.NANOCLAW_GATEWAY_READ_ONLY_HOSTS ?? envValue('NANOCLAW_GATEWAY_READ_ONLY_HOSTS') ?? '';
  const hosts = configured.split(',').map((host) => host.trim().toLowerCase());
  // Fail closed on a malformed rule, including URLs, wildcards and non-HTTPS ports.
  if (!hosts.length || hosts.some((host) => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)))
    return false;
  const host = destination.host.toLowerCase().replace(/:443$/, '');
  return hosts.includes(host);
}

/**
 * Opt-in, and only half the rule: the caller must still get the gateway's word
 * that no credential applies. Such a request can carry data in its URL and
 * headers, so the egress allowlist stays its only limit.
 */
export function permitsUncredentialedGatewayRead(destination: { method?: string; sendsPayload?: boolean }): boolean {
  if (destination.method !== 'GET' && destination.method !== 'HEAD') return false;
  if (destination.sendsPayload !== false) return false;
  const configured =
    process.env.NANOCLAW_GATEWAY_UNCREDENTIALED_READS ?? envValue('NANOCLAW_GATEWAY_UNCREDENTIALED_READS');
  return configured === 'true';
}
