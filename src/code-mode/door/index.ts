/**
 * The door: a loopback OpenSSH server the host supervises so a remote
 * terminal, once the account link relays it, lands in a code-mode sandbox.
 *
 * `ncl sandboxes remote enable [--name <name>]` generates the host key once,
 * asks the account link to confirm or assign the name, takes a loopback
 * port, renders sshd_config, starts the server and journals the decision;
 * the host restarts the door on every start while it is enabled. Approval
 * has two sources — keys the operator approved here and fingerprints the
 * service approved in the browser, applied from each snapshot — and the
 * host answers the forced commands over the door socket.
 *
 * The exported API is what the account link builds on: enableDoor /
 * disableDoor / startDoor / stopDoor / doorStatus, the target map, the
 * mirror application and the seam. Nothing here imports link code.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_SOCKET_PATH } from '../../cli/socket-client.js';
import { DATA_DIR } from '../../config.js';
import { onHostStart, onHostShutdown } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import * as authority from './authority.js';
import { startHostSocket, stopHostSocket, type HostSocketDeps } from './host-socket.js';
import { parsePublicKey, type ApprovedKey, type KeyStore } from './keys.js';
import { validateAccountName } from './name.js';
import { doorFiles, resolveEntry } from './paths.js';
import {
  enableTerminal,
  PENDING_APPROVAL_TTL_MS,
  reportPendingKey,
  reportTerminalState,
  type TerminalState,
} from './report.js';
import { renderSshdConfig } from './sshd-config.js';
import { DEFAULT_APPROVAL_URL, readDoorState, writeDoorState, type DoorState } from './state.js';
import { DoorSupervisor, type DoorSupervisorStatus } from './supervisor.js';
import { lookupTarget } from './target-map.js';

export {
  registerTarget,
  unregisterTarget,
  lookupTarget,
  type DoorSource,
  type DoorStream,
  type DoorTarget,
} from './target-map.js';
export {
  setTerminalSeam,
  type PendingKeyRequest,
  type PendingKeyResult,
  type TerminalEnableRequest,
  type TerminalEnableResult,
  type TerminalSeam,
  type TerminalState,
} from './report.js';
export type { MirrorDelta, MirrorTerminal } from './authority.js';

export const DOOR_DIR = path.join(DATA_DIR, 'door');
const files = doorFiles(DOOR_DIR);

/**
 * The server insists that its AuthorizedKeysCommand binary and every
 * directory above it are root-owned. `/usr/bin/env` is on every platform the
 * host runs on, and execs the host's own Node with the door's script; that
 * changes nothing about who is trusted — the config file, the key store and
 * the server process itself all belong to the host user already.
 */
const ENV_TRAMPOLINE = '/usr/bin/env';

const SSHD_CANDIDATES = ['/usr/sbin/sshd', '/usr/local/sbin/sshd', '/opt/homebrew/sbin/sshd', '/usr/bin/sshd'];

/** The door's loopback port range: the first free port in it is taken at enable and kept. */
export const DOOR_PORT_RANGE: readonly [number, number] = [33022, 33121];

let supervisor: DoorSupervisor | undefined;
/** The journal the running door was brought up from; undefined while down. */
let running: DoorState | undefined;
let authorityReady = false;

/** The shape the account link journals beside its own state. */
export interface TerminalJournal {
  enabled: boolean;
  name?: string;
  hostKeyFingerprint?: string;
  doorPort?: number;
  updatedAt: string;
}

export interface DoorSummary {
  enabled: boolean;
  name?: string;
  address?: string;
  host?: string;
  previousName?: string;
  doorPort?: number;
  hostKey?: string;
  hostKeyFingerprint?: string;
  approvalUrl: string;
  terminal: TerminalJournal;
  door: DoorSupervisorStatus | { running: false };
  keys: { approved: number; browser: number; pending: number; rooms: number };
}

function executable(file: string): boolean {
  return fs.existsSync(file) && (fs.statSync(file).mode & 0o111) !== 0;
}

/** The OpenSSH server binary: `NANOCLAW_SSHD`, the usual locations, then PATH. */
export function findSshd(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromPath = (env.PATH ?? '').split(path.delimiter).map((dir) => path.join(dir, 'sshd'));
  return [env.NANOCLAW_SSHD, ...SSHD_CANDIDATES, ...fromPath].find((file) => file && executable(file));
}

function approvalUrl(): string {
  return process.env.NANOCLAW_TERMINAL_APPROVAL_URL || DEFAULT_APPROVAL_URL;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const listener = net.createServer();
    listener.once('error', () => resolve(false));
    listener.listen(port, '127.0.0.1', () => listener.close(() => resolve(true)));
  });
}

async function freeDoorPort(): Promise<number> {
  for (let port = DOOR_PORT_RANGE[0]; port <= DOOR_PORT_RANGE[1]; port++) {
    if (await portFree(port)) return port;
  }
  throw new Error(`no free loopback port in ${DOOR_PORT_RANGE[0]}–${DOOR_PORT_RANGE[1]} for the door`);
}

async function ensureHostKey(): Promise<{ publicKey: string; fingerprint: string }> {
  await fs.promises.mkdir(DOOR_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(files.hostKey)) {
    await new Promise<void>((resolve, reject) => {
      const args = ['-q', '-t', 'ed25519', '-N', '', '-C', 'nanoclaw-door', '-f', files.hostKey];
      execFile('ssh-keygen', args, (error, _stdout, stderr) => {
        if (!error) return resolve();
        reject(new Error(`could not generate the door host key: ${stderr.trim() || error.message}`, { cause: error }));
      });
    });
  }
  const key = parsePublicKey(await readFile(files.hostKeyPublic, 'utf8'));
  return { publicKey: key.publicKey, fingerprint: key.fingerprint };
}

async function ensureAuthority(): Promise<void> {
  if (authorityReady) return;
  await fs.promises.mkdir(DOOR_DIR, { recursive: true, mode: 0o700 });
  await authority.initAuthority(files.keyStore);
  authorityReady = true;
}

function authorizedFingerprints(): string[] {
  const store = authority.keyStore();
  return [...new Set([...store.approved.map((k) => k.fingerprint), ...(store.mirror?.fingerprints ?? [])])];
}

async function terminalState(state: DoorState): Promise<TerminalState> {
  await ensureAuthority();
  return {
    enabled: state.enabled,
    ...(state.name ? { name: state.name } : {}),
    ...(state.hostKeyFingerprint ? { hostKeyFingerprint: state.hostKeyFingerprint } : {}),
    ...(state.doorPort ? { doorPort: state.doorPort } : {}),
    authorizedFingerprints: authorizedFingerprints(),
  };
}

function journal(state: DoorState): TerminalJournal {
  return {
    enabled: state.enabled,
    ...(state.name ? { name: state.name } : {}),
    ...(state.hostKeyFingerprint ? { hostKeyFingerprint: state.hostKeyFingerprint } : {}),
    ...(state.doorPort ? { doorPort: state.doorPort } : {}),
    updatedAt: state.updatedAt,
  };
}

function baseState(): DoorState {
  return {
    version: 1,
    enabled: false,
    approvalUrl: approvalUrl(),
    socketPath: DEFAULT_SOCKET_PATH,
    hostSocketPath: files.hostSocket,
    path: process.env.PATH ?? '',
    updatedAt: new Date().toISOString(),
  };
}

const socketDeps: HostSocketDeps = {
  lookupTarget,
  authorize: (fingerprint) => authority.authorizeStatus(fingerprint, running?.enabled === true),
  pending: async (request) => {
    const stream = request.port !== undefined ? lookupTarget(request.port) : undefined;
    if ((await authority.openRoom(request, stream?.source)) === 'limit') return 'limit';
    const at = new Date().toISOString();
    const url = running?.approvalUrl ?? approvalUrl();
    try {
      return await reportPendingKey({
        fingerprint: request.fingerprint,
        keyType: request.keyType,
        publicKey: request.publicKey,
        ...(stream?.source ? { source: stream.source } : {}),
        at,
        approvalUrl: url,
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // The room still works with an approval from this machine.
      log.warn('Pending terminal key could not be reported', { err: error });
      return { url, expiresAt: new Date(Date.now() + PENDING_APPROVAL_TTL_MS).toISOString() };
    }
  },
  waitApproval: (fingerprint, waitMs) => authority.waitForApproval(fingerprint, waitMs),
  registerSession: (request) => authority.registerSession(request),
};

/**
 * Render the config from the current process (Node binary, PATH, socket
 * paths may all have changed since the last start), journal, serve the door
 * socket and start the supervised sshd.
 */
async function bringUp(state: DoorState): Promise<DoorState> {
  if (!state.doorPort) throw new Error('the door has no port; run ncl sandboxes remote enable');
  const sshd = findSshd();
  if (!sshd) {
    throw new Error('OpenSSH server (sshd) not found — install the openssh-server package or set NANOCLAW_SSHD');
  }
  if (!executable(ENV_TRAMPOLINE)) throw new Error(`${ENV_TRAMPOLINE} is required to run the door`);
  await ensureAuthority();
  const refreshed: DoorState = {
    ...state,
    approvalUrl: approvalUrl(),
    socketPath: DEFAULT_SOCKET_PATH,
    hostSocketPath: files.hostSocket,
    path: process.env.PATH ?? '',
    updatedAt: new Date().toISOString(),
  };
  const config = renderSshdConfig({
    port: state.doorPort,
    hostKeyFile: files.hostKey,
    user: os.userInfo().username,
    authorizedKeysCommand: [ENV_TRAMPOLINE, ...resolveEntry('authorized-keys'), DOOR_DIR],
  });
  await fs.promises.writeFile(files.sshdConfig, config, { mode: 0o600 });
  await writeDoorState(files.state, refreshed);
  running = refreshed;
  await startHostSocket(files.hostSocket, socketDeps);
  supervisor ??= new DoorSupervisor({
    sshd,
    configFile: files.sshdConfig,
    port: state.doorPort,
    wrapper: resolveEntry('sshd-wrapper'),
    log: (level, message, data) => log[level](message, data),
  });
  try {
    await supervisor.start();
  } catch (error) {
    running = undefined;
    throw error;
  }
  return refreshed;
}

async function takeDown(): Promise<void> {
  const current = supervisor;
  supervisor = undefined;
  running = undefined;
  await current?.stop();
  await stopHostSocket();
}

async function summarize(state: DoorState): Promise<DoorSummary> {
  await ensureAuthority();
  const store = authority.keyStore();
  return {
    enabled: state.enabled,
    ...(state.name ? { name: state.name } : {}),
    ...(state.address ? { address: state.address } : {}),
    ...(state.host ? { host: state.host } : {}),
    ...(state.previousName ? { previousName: state.previousName } : {}),
    ...(state.doorPort ? { doorPort: state.doorPort } : {}),
    ...(state.hostKey ? { hostKey: state.hostKey } : {}),
    ...(state.hostKeyFingerprint ? { hostKeyFingerprint: state.hostKeyFingerprint } : {}),
    approvalUrl: state.approvalUrl,
    terminal: journal(state),
    door: supervisor?.status() ?? { running: false },
    keys: {
      approved: store.approved.length,
      browser: store.mirror?.fingerprints.length ?? 0,
      pending: store.pending.length,
      rooms: authority.openRooms(),
    },
  };
}

/**
 * Enable remote access. The name is confirmed (or assigned, when omitted)
 * by the account link through the seam and stored from its answer, never
 * derived here; the door port is chosen once and kept.
 */
export async function enableDoor(options: { name?: string } = {}): Promise<DoorSummary> {
  const requested = options.name === undefined ? undefined : validateAccountName(options.name);
  const previous = await readDoorState(files.state);
  const hostKey = await ensureHostKey();
  const assigned = await enableTerminal({
    ...(requested ? { name: requested } : {}),
    hostKey: hostKey.publicKey,
    hostKeyFingerprint: hostKey.fingerprint,
  });
  const name = validateAccountName(assigned.name);
  const previousName = assigned.previousName ?? (previous?.name && previous.name !== name ? previous.name : undefined);
  const now = new Date().toISOString();
  const state = await bringUp({
    ...baseState(),
    enabled: true,
    name,
    ...(assigned.address ? { address: assigned.address } : {}),
    ...(assigned.host ? { host: assigned.host } : {}),
    ...(previousName ? { previousName } : {}),
    doorPort: previous?.doorPort ?? (await freeDoorPort()),
    hostKey: hostKey.publicKey,
    hostKeyFingerprint: hostKey.fingerprint,
    enabledAt: previous?.enabled && previous.enabledAt ? previous.enabledAt : now,
  });
  await reportTerminalState(await terminalState(state));
  return summarize(state);
}

export async function disableDoor(): Promise<DoorSummary> {
  await takeDown();
  const previous = await readDoorState(files.state);
  const state: DoorState = { ...(previous ?? baseState()), enabled: false, updatedAt: new Date().toISOString() };
  await writeDoorState(files.state, state);
  await reportTerminalState(await terminalState(state));
  return summarize(state);
}

/** Bring the door up from its journal without changing the decision (a restart). */
export async function startDoor(): Promise<DoorSummary> {
  const state = await readDoorState(files.state);
  if (!state?.enabled) throw new Error('remote access is not enabled — run ncl sandboxes remote enable');
  if (running) return summarize(running);
  const started = await bringUp(state);
  await reportTerminalState(await terminalState(started));
  return summarize(started);
}

/** Take the door down without changing the journal; the next host start brings it back. */
export async function stopDoor(): Promise<DoorSummary> {
  await takeDown();
  return summarize((await readDoorState(files.state)) ?? baseState());
}

export async function doorStatus(): Promise<DoorSummary> {
  return summarize((await readDoorState(files.state)) ?? baseState());
}

/**
 * Apply the account service's `terminal` section from a snapshot push:
 * browser approvals release waiting rooms, revocations end sessions, a
 * rename is journaled with the previous name, and `enabled: false` from the
 * browser disables the door here.
 */
export async function applyTerminalMirror(
  terminal: authority.MirrorTerminal | undefined,
): Promise<authority.MirrorDelta> {
  await ensureAuthority();
  const delta = await authority.applyMirror(terminal);
  if (delta.approved.length || delta.revoked.length) {
    log.info('Remote terminal keys updated from the account', { approved: delta.approved, revoked: delta.revoked });
  }
  const state = await readDoorState(files.state);
  if (state?.enabled && terminal) {
    if (terminal.name && terminal.name !== state.name) {
      const renamed: DoorState = {
        ...state,
        previousName: terminal.previousName ?? state.name,
        name: terminal.name,
        updatedAt: new Date().toISOString(),
      };
      await writeDoorState(files.state, renamed);
      if (running) running = { ...running, name: renamed.name, previousName: renamed.previousName };
      log.info('Remote terminal renamed', { from: state.name, to: terminal.name });
    }
    if (terminal.enabled === false) {
      log.info('Remote terminal access disabled from the account');
      await disableDoor();
    }
  }
  return delta;
}

export async function listDoorKeys(): Promise<KeyStore> {
  await ensureAuthority();
  return authority.keyStore();
}

/** `text` is a public key line or the path of a file holding one. */
export async function addDoorKey(text: string, label?: string): Promise<ApprovedKey> {
  await ensureAuthority();
  let line = text.trim();
  const candidate = line.startsWith('~/') ? path.join(os.homedir(), line.slice(2)) : line;
  if (!/\s/.test(line) && fs.existsSync(candidate)) line = await readFile(candidate, 'utf8');
  return authority.addKey(parsePublicKey(line), label ?? '');
}

export async function approveDoorKey(fingerprint: string, label?: string): Promise<ApprovedKey> {
  await ensureAuthority();
  return authority.approveKey(fingerprint, label);
}

export async function revokeDoorKey(fingerprint: string): Promise<{ fingerprint: string }> {
  await ensureAuthority();
  await authority.revokeKey(fingerprint);
  return { fingerprint };
}

onHostStart(async () => {
  await ensureAuthority();
  const state = await readDoorState(files.state);
  if (!state?.enabled) return;
  try {
    await reportTerminalState(await terminalState(await bringUp(state)));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // The door is optional: a host must still come up without it.
    log.error('Remote terminal door failed to start', { err: error });
  }
});

onHostShutdown(() => takeDown());
