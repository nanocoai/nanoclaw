/**
 * The waiting room — what an unknown key sees. Deliberately tiny: it is the
 * surface strangers reach behind the SSH handshake. Registers the key as
 * pending (rooms are capped per machine; the account link mints the
 * approval code), prints the fingerprint, where the connection came from,
 * the time and the approval page, then waits; approval continues into the
 * landing in the same session, a timeout ends it.
 */
import type { LandingIo } from './landing.js';
import type { PendingKeyRequest, PendingKeyResult } from './report.js';
import type { DoorSource } from './target-map.js';

export const WAITING_ROOM_TIMEOUT_MS = 10 * 60_000;
/** One wait round; the room re-checks the connection between rounds. */
export const WAITING_ROOM_POLL_MS = 25_000;

export interface WaitingRoomDeps {
  fingerprint: string;
  keyType: string;
  /** `<type> <base64>` */
  publicKey: string;
  source?: DoorSource;
  approvalUrl: string;
  io: LandingIo;
  closed(): boolean;
  openRoom(
    request: { fingerprint: string; keyType: string; publicKey: string },
    source?: DoorSource,
  ): Promise<'ok' | 'limit'>;
  pending(request: PendingKeyRequest): Promise<PendingKeyResult>;
  /** Resolves true as soon as the key is approved, false after `waitMs`. */
  waitForApproval(fingerprint: string, waitMs: number): Promise<boolean>;
  now?: () => Date;
  timeoutMs?: number;
  pollMs?: number;
}

export function waitingRoomBanner(
  fingerprint: string,
  source: string,
  at: Date,
  approvalUrl: string,
  code?: string,
): string {
  return [
    '',
    'This terminal is not approved for remote access yet.',
    '',
    `  key    ${fingerprint}`,
    `  from   ${source}`,
    `  at     ${at.toISOString()}`,
    ...(code ? [`  code   ${code}`] : []),
    '',
    `Approve it in your browser: ${approvalUrl}`,
    `or on the machine:          ncl sandboxes remote keys approve ${fingerprint}`,
    '',
    'Waiting for approval (up to 10 minutes)…',
    '',
  ].join('\n');
}

/** Resolves true once the key is approved and the session may continue. */
export async function runWaitingRoom(deps: WaitingRoomDeps): Promise<boolean> {
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? WAITING_ROOM_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? WAITING_ROOM_POLL_MS;
  const { fingerprint, keyType, publicKey, source, io } = deps;
  if ((await deps.openRoom({ fingerprint, keyType, publicKey }, source)) === 'limit') {
    io.fail('Too many pending approvals on this machine; try again in a few minutes.\n');
    return false;
  }
  const started = now();
  let result: PendingKeyResult;
  try {
    result = await deps.pending({
      fingerprint,
      keyType,
      publicKey,
      ...(source ? { source } : {}),
      at: started.toISOString(),
      approvalUrl: deps.approvalUrl,
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // The room still works with an approval from this machine.
    result = { url: deps.approvalUrl, expiresAt: new Date(started.getTime() + timeoutMs).toISOString() };
  }
  io.write(waitingRoomBanner(fingerprint, source?.ip ?? 'remote', started, result.url, result.code));
  for (;;) {
    if (deps.closed()) return false;
    if (await deps.waitForApproval(fingerprint, pollMs)) {
      if (deps.closed()) return false;
      io.write('Approved. Connecting…\n');
      return true;
    }
    if (now().getTime() - started.getTime() >= timeoutMs) {
      io.write('Not approved within 10 minutes. Approve the key, then connect again.\n');
      return false;
    }
  }
}
