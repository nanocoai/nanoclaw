/**
 * The waiting room — the forced command an unknown key runs. Deliberately
 * tiny: it is the surface strangers reach behind the OpenSSH handshake.
 * Prints the fingerprint, where the connection came from, the time and the
 * approval page, then polls the approved-keys store; approval hands the
 * terminal to the landing program, a timeout ends the session.
 */
import { spawnSync } from 'node:child_process';

import { isApproved, readKeyStore } from './keys.js';
import { clientPortFromSshConnection } from './landing.js';
import { doorFiles, isMainModule, resolveEntry } from './paths.js';
import { readDoorState } from './state.js';
import { fetchTarget } from './target-client.js';
import type { DoorStream } from './target-map.js';

export const WAITING_ROOM_TIMEOUT_MS = 10 * 60_000;
export const WAITING_ROOM_POLL_MS = 2_000;

export interface WaitingRoomDeps {
  fingerprint: string;
  source: string;
  approvalUrl: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  isApproved: () => Promise<boolean>;
  write: (text: string) => void;
  /** Hand the terminal to the landing program; resolves with its exit code. */
  exec: () => Promise<number> | number;
  timeoutMs?: number;
  pollMs?: number;
}

export function waitingRoomBanner(fingerprint: string, source: string, at: Date, approvalUrl: string): string {
  return [
    '',
    'This terminal is not approved for remote access yet.',
    '',
    `  key    ${fingerprint}`,
    `  from   ${source}`,
    `  at     ${at.toISOString()}`,
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
  const pollMs = deps.pollMs ?? WAITING_ROOM_POLL_MS;
  const started = deps.now();
  deps.write(waitingRoomBanner(deps.fingerprint, deps.source, started, deps.approvalUrl));
  for (;;) {
    if (await deps.isApproved()) {
      deps.write('Approved. Connecting…\n');
      return deps.exec();
    }
    if (deps.now().getTime() - started.getTime() >= timeoutMs) {
      deps.write('Not approved within 10 minutes. Approve the key, then connect again.\n');
      return 1;
    }
    await deps.sleep(pollMs);
  }
}

async function main(argv: string[]): Promise<number> {
  const [doorDir, fingerprint] = argv;
  if (!doorDir || !fingerprint) {
    process.stderr.write('waiting-room: usage: waiting-room <doorDir> <fingerprint>\n');
    return 2;
  }
  const files = doorFiles(doorDir);
  const state = await readDoorState(files.state);
  if (!state?.enabled) {
    process.stderr.write('Remote access is disabled on this machine.\n');
    return 1;
  }
  let stream: DoorStream | undefined;
  const port = clientPortFromSshConnection(process.env.SSH_CONNECTION);
  if (port !== undefined) {
    try {
      stream = await fetchTarget(state.hostSocketPath, port);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      stream = undefined;
    }
  }
  const landing = [...resolveEntry('landing'), doorDir, fingerprint, ...(stream ? [JSON.stringify(stream)] : [])];
  return runWaitingRoom({
    fingerprint,
    source: stream?.source?.ip ?? 'remote',
    approvalUrl: state.approvalUrl,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    isApproved: async () => isApproved(await readKeyStore(files.keyStore), fingerprint),
    write: (text) => process.stdout.write(text),
    exec: () => spawnSync(landing[0], landing.slice(1), { stdio: 'inherit' }).status ?? 1,
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
