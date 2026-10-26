/**
 * Publish OneCLI's admin API and Postgres on 127.0.0.1 only.
 *
 * On bare-metal Linux the OneCLI installer publishes every port on the docker0
 * address. These published host ports use loopback; the gateway proxy port
 * stays on the Docker bridge.
 */
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';

export const ADMIN_LOOPBACK_MARKER = '# nanoclaw: admin API and Postgres published on 127.0.0.1 only';

const BIND = '${ONECLI_BIND_HOST:-127.0.0.1}';
const ADMIN_PORT = '${ONECLI_APP_PORT:-10254}:10254';
const POSTGRES_PORT = '${POSTGRES_PORT:-5432}:5432';

export type PinStatus = 'pinned' | 'already-pinned' | 'unrecognized';

type ComposeServices = Record<string, { ports?: unknown; environment?: Record<string, unknown> }>;

/** Recognize the complete port lists before rewriting the stock lines. */
function stockPortsOnly(services: ComposeServices): boolean {
  try {
    const admin = services?.onecli?.ports;
    const postgres = services?.postgres?.ports;
    const matches = (entry: unknown, port: string) => entry === `${BIND}:${port}` || entry === `127.0.0.1:${port}`;
    return (
      Array.isArray(admin) &&
      admin.length === 2 &&
      admin.some((entry) => matches(entry, ADMIN_PORT)) &&
      admin.includes(`${BIND}:\${ONECLI_GATEWAY_PORT:-10255}:10255`) &&
      Array.isArray(postgres) &&
      postgres.length === 1 &&
      matches(postgres[0], POSTGRES_PORT) &&
      Object.entries(services).every(
        ([name, service]) => name === 'onecli' || name === 'postgres' || !(service as { ports?: unknown }).ports,
      )
    );
  } catch {
    return false;
  }
}

/**
 * Publish the admin API and Postgres on 127.0.0.1, leaving the gateway port
 * on ONECLI_BIND_HOST. Only the exact upstream port lines are rewritten, and
 * only when they are each port's sole mapping: any other layout is returned
 * unchanged as 'unrecognized'.
 */
export function pinAdminToLoopback(compose: string): { compose: string; status: PinStatus } {
  const normalized = compose.replaceAll('\r\n', '\n');
  const document = parseDocument(normalized, { merge: true });
  if (document.errors.length) return { compose, status: 'unrecognized' };
  let services: ComposeServices | undefined;
  try {
    services = document.toJS()?.services;
  } catch {
    return { compose, status: 'unrecognized' };
  }
  if (!services || !stockPortsOnly(services)) return { compose, status: 'unrecognized' };

  const edits: { start: number; end: number; value: string }[] = [];
  for (const [service, port] of [
    ['onecli', ADMIN_PORT],
    ['postgres', POSTGRES_PORT],
  ]) {
    const ports = document.getIn(['services', service, 'ports'], true);
    if (!isSeq(ports)) return { compose, status: 'unrecognized' };
    const entry = ports.items.find(
      (item) => isScalar(item) && (item.value === `${BIND}:${port}` || item.value === `127.0.0.1:${port}`),
    );
    if (!isScalar(entry) || !entry.range || entry.anchor || entry.type !== 'QUOTE_DOUBLE') {
      return { compose, status: 'unrecognized' };
    }
    // Edit the validated service entry's source range, never a matching example elsewhere.
    edits.push({ start: entry.range[0], end: entry.range[1], value: `"127.0.0.1:${port}"` });
  }
  const environment = document.getIn(['services', 'onecli', 'environment'], true);
  if (environment !== undefined && !isMap(environment)) return { compose, status: 'unrecognized' };
  const appUrl = document.getIn(['services', 'onecli', 'environment', 'APP_URL'], true);
  if (services.onecli.environment?.APP_URL !== undefined) {
    if (
      !isScalar(appUrl) ||
      !appUrl.range ||
      appUrl.anchor ||
      !['PLAIN', 'QUOTE_SINGLE', 'QUOTE_DOUBLE'].includes(appUrl.type ?? '')
    )
      return { compose, status: 'unrecognized' };
    edits.push({
      start: appUrl.range[0],
      end: appUrl.range[1],
      // Without INTERNAL_API_URL (1.42) OneCLI calls its own API through
      // APP_URL from inside the container: fixed, on the container's port.
      value: JSON.stringify(
        services.onecli.environment?.INTERNAL_API_URL === undefined
          ? 'http://127.0.0.1:10254'
          : '${APP_URL:-http://127.0.0.1:${ONECLI_APP_PORT:-10254}}',
      ),
    });
  }
  let next = normalized;
  for (const { start, end, value } of edits.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, start) + value + next.slice(end);
  }
  if (next === normalized) return { compose, status: 'already-pinned' };
  if (!next.includes(ADMIN_LOOPBACK_MARKER)) next = `${ADMIN_LOOPBACK_MARKER}\n${next}`;
  if (compose.includes('\r\n')) next = next.replaceAll('\n', '\r\n');
  return { compose: next, status: 'pinned' };
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  return bare === 'localhost' || bare === '::1' || /^127\.\d+\.\d+\.\d+$/.test(bare);
}

/** Bindings from `docker port` output, one per line ("172.17.0.1:10254", "[::]:5432"). */
export function parsePublishedPorts(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(\[[^\]\s]+\]|[^\s:[\]]+):\d+$/.test(line));
}

export function bindingHost(binding: string): string {
  return binding.slice(0, binding.lastIndexOf(':')).replace(/^\[|\]$/g, '');
}
