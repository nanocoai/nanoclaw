/**
 * Source-port → target map.
 *
 * The host pipes each relayed terminal stream into the door from a distinct
 * loopback source port and registers what that stream is for: an account
 * (land in its default sandbox) or one named sandbox, plus where it came
 * from. The forced command a connection lands in reads its client port from
 * `SSH_CONNECTION` and asks the host over the door socket (host-socket.ts,
 * `GET /target?port=N`) — it runs as a child of the OpenSSH server, not
 * inside the host process. Entries expire on a TTL so a port number reused
 * by an unrelated connection cannot inherit a stale target; the piping side
 * unregisters when its door socket closes.
 */

export interface DoorTarget {
  /** The account name (not an id); the default sandbox is named after it. */
  account: string;
  /** A specific sandbox to attach instead of the account default. */
  sandbox?: string;
}

export interface DoorSource {
  ip: string;
  port: number;
}

/** What the host knows about one relayed stream, keyed by its loopback source port. */
export interface DoorStream {
  target: DoorTarget;
  /** The remote client's public address as the relay saw it. */
  source?: DoorSource;
  /** The relay's stream id, for log correlation only. */
  stream?: string;
  openedAt: string;
}

export const DEFAULT_TARGET_TTL_MS = 5 * 60_000;

interface Entry {
  stream: DoorStream;
  expiresAt: number;
}

const streams = new Map<number, Entry>();

export function validPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

export function registerTarget(
  port: number,
  entry: Omit<DoorStream, 'openedAt'> & { openedAt?: string },
  ttlMs: number = DEFAULT_TARGET_TTL_MS,
  now: number = Date.now(),
): void {
  if (!validPort(port)) throw new Error(`invalid source port ${port}`);
  if (!entry.target?.account) throw new Error('a target needs an account');
  const stream: DoorStream = {
    target: { ...entry.target },
    ...(entry.source ? { source: { ...entry.source } } : {}),
    ...(entry.stream ? { stream: entry.stream } : {}),
    openedAt: entry.openedAt ?? new Date(now).toISOString(),
  };
  streams.set(port, { stream, expiresAt: now + ttlMs });
}

export function unregisterTarget(port: number): void {
  streams.delete(port);
}

export function lookupTarget(port: number, now: number = Date.now()): DoorStream | undefined {
  const entry = streams.get(port);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    streams.delete(port);
    return undefined;
  }
  return structuredClone(entry.stream);
}

export function clearTargets(): void {
  streams.clear();
}
