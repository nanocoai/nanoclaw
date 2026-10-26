/**
 * OneCLI hands agents the proxy in its GATEWAY_BASE_URL, which defaults to
 * host.docker.internal:10255: the agent's own machine. For a gateway on another
 * host that is a port nothing serves, so every model call retries with no reply
 * and no error until the gateway host overrides it.
 */
import { execFileSync } from 'child_process';
import dns from 'dns';
import net from 'net';
import os from 'os';

type Interfaces = ReturnType<typeof os.networkInterfaces>;
type Lookup = (host: string) => Promise<string[]>;

function bare(host: string): string {
  return host.replace(/^\[|\]$/g, '').toLowerCase();
}

function isLoopback(host: string): boolean {
  const h = bare(host);
  return h === 'localhost' || h === '::1' || (net.isIPv4(h) && h.startsWith('127.'));
}

/** An address that, seen from inside an agent container, is that container or its host. */
function isAgentLocal(host: string): boolean {
  const h = bare(host);
  return isLoopback(h) || h === 'host.docker.internal' || h === '0.0.0.0' || h === '::';
}

/** Every address in `ip -o addr show` output: the local side of each `inet`/`inet6` field. */
export function ipAddrAddresses(output: string): string[] {
  const words = output.split(/\s+/);
  return words
    .flatMap((w, i) => (w === 'inet' || w === 'inet6' ? [(words[i + 1] ?? '').split('/')[0].toLowerCase()] : []))
    .filter((a) => net.isIP(a));
}

const readIpAddr = () =>
  execFileSync('ip', ['-o', 'addr', 'show'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });

/**
 * This machine's addresses. Node lists only interfaces that are up with a
 * carrier, so it drops docker0 while no container uses the bridge; on Linux,
 * `ip` lists addresses on down interfaces too.
 */
export function ownAddresses(
  deps: { interfaces?: Interfaces; platform?: NodeJS.Platform; ipAddr?: () => string } = {},
): string[] {
  const own = Object.values(deps.interfaces ?? os.networkInterfaces()).flatMap((addrs) =>
    (addrs ?? []).map((a) => a.address.toLowerCase()),
  );
  if ((deps.platform ?? process.platform) !== 'linux') return own;
  try {
    return [...own, ...ipAddrAddresses((deps.ipAddr ?? readIpAddr)())];
  } catch {
    return own;
  }
}

function isThisMachine(host: string, own: readonly string[]): boolean {
  const h = bare(host);
  return isLoopback(h) || own.includes(h);
}

/** The proxy URL from a /v1/container-config answer, or null. Carries the agent token. */
export function advertisedProxy(config: unknown): URL | null {
  const env = (config as { env?: Record<string, unknown> } | null)?.env;
  const raw = env?.HTTPS_PROXY ?? env?.https_proxy ?? env?.HTTP_PROXY ?? env?.http_proxy;
  if (typeof raw !== 'string') return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * The container config of an existing agent: the seeded "default", else the
 * project's current default. Always named: OneCLI answers 404 for an unknown
 * name, but without `agent=` it creates a default agent when none exists (up
 * to 1.43 with access to every secret). Never throws: setup only warns from it.
 */
export async function readContainerConfig(
  gatewayUrl: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; config: unknown } | { ok: false; reason: string }> {
  const base = gatewayUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (process.env.ONECLI_PROJECT_ID) headers['X-Project-Id'] = process.env.ONECLI_PROJECT_ID;
  const get = (route: string) => fetchImpl(`${base}${route}`, { headers, signal: AbortSignal.timeout(5000) });
  try {
    let res = await get('/v1/container-config?agent=default');
    if (res.status === 404) {
      const agents = (await (await get('/v1/agents')).json().catch(() => [])) as unknown;
      const list = Array.isArray(agents) ? (agents as { identifier?: unknown; isDefault?: unknown }[]) : [];
      const id = (list.find((a) => a.isDefault === true) ?? list[0])?.identifier;
      if (typeof id !== 'string' || id === 'default') return { ok: false, reason: 'no agent to read' };
      res = await get(`/v1/container-config?agent=${encodeURIComponent(id)}`);
    }
    if (!res.ok) return { ok: false, reason: `status ${res.status}` };
    return { ok: true, config: await res.json() };
  } catch (err) {
    // The name only: a message could echo request details.
    return { ok: false, reason: err instanceof Error ? err.name : 'unknown error' };
  }
}

const lookupAll: Lookup = async (host) => (await dns.promises.lookup(host, { all: true })).map((a) => a.address);

/**
 * The shell command that saves GATEWAY_BASE_URL and recreates the onecli
 * service alone on the tag, bind and ports it runs with now: the installer may
 * not have saved them, and compose's defaults are `latest` and loopback. A
 * failed read, a non-stock image or an unpinned tag (compose pulls `latest`
 * anew; picking a version here could downgrade) stops the chain before
 * anything changes. Older compose files don't pass ~/.onecli/.env into the
 * container, so it ends by reading the value back from inside it.
 */
export function gatewayRecreateCommand(host: string): string {
  return (
    `cd ~/.onecli && img="$(docker inspect -f '{{.Config.Image}}' onecli)" && ` +
    'v="${img#ghcr.io/onecli/onecli:}" && [ "$v" != "$img" ] && ' +
    'case "$v" in [0-9]*.[0-9]*.[0-9]*|*sha256:*) ;; *) echo "onecli runs $img, not a pinned release: ' +
    'recreate it on one first (docs/onecli-upgrades.md in NanoClaw), then run this again" >&2; false ;; esac && ' +
    'gw="$(docker port onecli 10255/tcp | head -n1)" && app="$(docker port onecli 10254/tcp | head -n1)" && ' +
    '[ -n "$gw" ] && [ -n "$app" ] && ' +
    `val="${host}:\${gw##*:}" && ` +
    `case "$val" in *'<'*) echo 'Replace <gateway-host> with this host address first' >&2; false ;; esac && ` +
    // Built in a unique temp file and renamed over .env, so .env is always whole;
    // the line is replaced where it stands. An unreadable .env stops here.
    '(umask 077 && touch .env && t="$(mktemp .env.XXXXXX)" && ' +
    `if awk -v l="GATEWAY_BASE_URL=$val" '/^[[:space:]]*GATEWAY_BASE_URL[[:space:]]*=/ { if (!d) print l; d = 1; next } ` +
    `{ print } END { if (!d) print l }' .env > "$t"; then mv -f "$t" .env || ` +
    '{ echo "Could not replace ~/.onecli/.env; its full new contents are in ~/.onecli/$t" >&2; false; }; ' +
    'else rm -f "$t"; false; fi) && ' +
    'ONECLI_VERSION="$v" ONECLI_BIND_HOST="${gw%:*}" ONECLI_GATEWAY_PORT="${gw##*:}" ' +
    'ONECLI_APP_PORT="${app##*:}" docker compose up -d --no-deps onecli && ' +
    '{ [ "$(docker exec onecli printenv GATEWAY_BASE_URL)" = "$val" ] || { echo ' +
    "'GATEWAY_BASE_URL did not reach the onecli container: its compose file does not load ~/.onecli/.env. " +
    "Add GATEWAY_BASE_URL: ${GATEWAY_BASE_URL} under the onecli service environment:, then run this again' >&2; " +
    'false; }; }'
  );
}

/**
 * A one-line warning with the exact fix when a gateway on another host points
 * agents at their own machine, else null. Prints host and port only, never the
 * proxy's credentials.
 */
export function remoteProxyHint(
  gatewayUrl: string,
  config: unknown,
  gatewayAddresses: string[] = [],
  own: readonly string[] = ownAddresses(),
): string | null {
  const proxy = advertisedProxy(config);
  // An address of this host is the agent's own machine too (e.g. its docker bridge).
  if (!proxy || !(isAgentLocal(proxy.hostname) || isThisMachine(proxy.hostname, own))) return null;
  const gatewayHost = new URL(gatewayUrl).hostname;
  if ([gatewayHost, ...gatewayAddresses].some((h) => isThisMachine(h, own))) return null;
  const port = proxy.port || '80';
  // The host lands in a shell command the operator runs on the gateway host.
  const host = /^[A-Za-z0-9.:[\]-]+$/.test(gatewayHost) ? gatewayHost : '<gateway-host>';
  const recreate = gatewayRecreateCommand(host);
  return (
    `The remote OneCLI gateway tells agents to use the proxy ${proxy.hostname}:${port}, their own machine, ` +
    'so model calls will hang with no reply. On the gateway host, set GATEWAY_BASE_URL to its own address and ' +
    `the gateway port it publishes, and recreate the onecli service as it runs now: ${recreate}. ` +
    'The command checks the value inside the container and says what to change if it did not arrive. ' +
    'Re-run setup to check.'
  );
}

/** Every outcome carries a sentence, so an agent applying the skill by hand can relay any of them. */
export type ProxyCheck = { status: 'ok' | 'warn' | 'skipped'; hint: string };

const REACHABLE: ProxyCheck = { status: 'ok', hint: 'OneCLI hands agents a proxy address they can reach.' };

export function skippedCheck(reason: string): ProxyCheck {
  return { status: 'skipped', hint: `Could not check the proxy address OneCLI hands agents (${reason}).` };
}

/** The gateway URL and API key the runtime uses: process env first, then `.env`. */
export function runtimeGateway(
  env: NodeJS.ProcessEnv,
  saved: Record<string, string>,
): { url: string | undefined; apiKey: string | undefined } {
  return {
    url: env.ONECLI_URL || saved.ONECLI_URL || undefined,
    apiKey: env.ONECLI_API_KEY || saved.ONECLI_API_KEY || undefined,
  };
}

/** Read the proxy a gateway hands agents and judge it; a local gateway is fine. */
export async function checkRemoteProxy(
  gatewayUrl: string,
  apiKey: string | undefined,
  deps: { fetchImpl?: typeof fetch; lookup?: Lookup; ownAddresses?: readonly string[] } = {},
): Promise<ProxyCheck> {
  const own = deps.ownAddresses ?? ownAddresses();
  const host = new URL(gatewayUrl).hostname;
  let addresses: string[] = [];
  try {
    addresses = await (deps.lookup ?? lookupAll)(host);
  } catch {
    // Unresolved here: judge the name as given.
  }
  if ([host, ...addresses].some((h) => isThisMachine(h, own))) return REACHABLE;
  const read = await readContainerConfig(gatewayUrl, apiKey, deps.fetchImpl);
  if (!read.ok) return skippedCheck(read.reason);
  const hint = remoteProxyHint(gatewayUrl, read.config, addresses, own);
  return hint ? { status: 'warn', hint } : REACHABLE;
}
