/**
 * Whether a Node version (e.g. "22.20.0") honors NODE_USE_ENV_PROXY for both
 * fetch and http(s). 22.21+ does; 23.x ignores it; 24.0-24.4 only proxies fetch.
 */
export function nodeHonorsEnvProxy(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  if (major === 22) return minor >= 21;
  if (major === 24) return minor >= 5;
  return major >= 25;
}
