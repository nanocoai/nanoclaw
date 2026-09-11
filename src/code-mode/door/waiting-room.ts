/**
 * The waiting room — the forced command an unknown key runs. Deliberately
 * tiny: it is the surface strangers reach behind the OpenSSH handshake.
 * Registers the key as pending with the host (which caps rooms and, through
 * the account link, mints the approval code), prints the fingerprint, where
 * the connection came from, the time and the approval page, then long-polls
 * the host; approval hands the terminal to the landing program in the same
 * session, a timeout ends it.
 */
import { fetchTarget, postPending, waitApproval } from './door-client.js';
import { runForeground } from './foreground.js';
import { clientPortFromSshConnection } from './landing.js';
import { doorFiles, isMainModule, resolveEntry } from './paths.js';
import { readDoorState } from './state.js';
import type { DoorStream } from './target-map.js';

export const WAITING_ROOM_TIMEOUT_MS = 10 * 60_000;
/** One long-poll round at the host. */
export const WAITING_ROOM_POLL_S = 25;
const RETRY_AFTER_ERROR_MS = 2_000;

export interface WaitingRoomDeps {
  fingerprint: string;
  source: string;
  approvalUrl: string;
  code?: string;
  now: () => Date;
  /** One long-poll round; resolves true once the key is approved. */
  waitApproval: () => Promise<boolean>;
  write: (text: string) => void;
  /** Hand the terminal to the landing program; resolves with its exit code. */
  exec: () => Promise<number> | number;
  timeoutMs?: number;
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

export async function runWaitingRoom(deps: WaitingRoomDeps): Promise<number> {
  const timeoutMs = deps.timeoutMs ?? WAITING_ROOM_TIMEOUT_MS;
  const started = deps.now();
  deps.write(waitingRoomBanner(deps.fingerprint, deps.source, started, deps.approvalUrl, deps.code));
  for (;;) {
    if (await deps.waitApproval()) {
      deps.write('Approved. Connecting…\n');
      return deps.exec();
    }
    if (deps.now().getTime() - started.getTime() >= timeoutMs) {
      deps.write('Not approved within 10 minutes. Approve the key, then connect again.\n');
      return 1;
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(argv: string[]): Promise<number> {
  const [doorDir, fingerprint, keyType, publicKey] = argv;
  if (!doorDir || !fingerprint || !keyType || !publicKey) {
    process.stderr.write('waiting-room: usage: waiting-room <doorDir> <fingerprint> <key type> <key>\n');
    return 2;
  }
  const files = doorFiles(doorDir);
  const state = await readDoorState(files.state);
  if (!state?.enabled) {
    process.stderr.write('Remote access is disabled on this machine.\n');
    return 1;
  }
  const port = clientPortFromSshConnection(process.env.SSH_CONNECTION);
  let stream: DoorStream | undefined;
  if (port !== undefined) {
    try {
      stream = await fetchTarget(state.hostSocketPath, port);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      stream = undefined;
    }
  }
  let pending;
  try {
    pending = await postPending(state.hostSocketPath, { fingerprint, keyType, publicKey, port });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    process.stderr.write(`The host is not reachable: ${error.message}\n`);
    return 1;
  }
  if (pending === 'limit') {
    process.stderr.write('Too many pending approvals on this machine; try again in a few minutes.\n');
    return 1;
  }
  const landing = [...resolveEntry('landing'), doorDir, fingerprint, ...(stream ? [JSON.stringify(stream)] : [])];
  return runWaitingRoom({
    fingerprint,
    source: stream?.source?.ip ?? 'remote',
    approvalUrl: pending.url,
    code: pending.code,
    now: () => new Date(),
    waitApproval: async () => {
      try {
        return await waitApproval(state.hostSocketPath, fingerprint, WAITING_ROOM_POLL_S);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        await sleep(RETRY_AFTER_ERROR_MS);
        return false;
      }
    },
    write: (text) => process.stdout.write(text),
    exec: () => runForeground(landing[0], landing.slice(1)),
  });
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`waiting-room: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
