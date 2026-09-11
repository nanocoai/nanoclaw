/**
 * The door: a loopback OpenSSH server the host supervises so a remote
 * terminal, once the account link relays it, lands in a code-mode sandbox.
 *
 * `ncl sandboxes remote enable --name <name>` generates the host key once,
 * picks a loopback port, renders sshd_config, starts the server and journals
 * the decision; the host restarts the door on every start while it is
 * enabled. Keys are approved per fingerprint in a store the host owns; an
 * unknown key lands in the waiting room, an approved one in a sandbox.
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
import {
  addApprovedKey,
  approvePendingKey,
  parsePublicKey,
  readKeyStore,
  revokeKey,
  writeKeyStore,
  type ApprovedKey,
  type KeyStore,
} from './keys.js';
import { validateAccountName } from './name.js';
import { doorFiles, resolveEntry } from './paths.js';
import { reportTerminalState, type TerminalState } from './report.js';
import { renderSshdConfig } from './sshd-config.js';
import { DEFAULT_APPROVAL_URL, readDoorState, writeDoorState, type DoorState } from './state.js';
import { DoorSupervisor, type DoorSupervisorStatus } from './supervisor.js';
import { startTargetServer, stopTargetServer } from './target-map.js';

export {
  registerTarget,
  unregisterTarget,
  lookupTarget,
  type DoorSource,
  type DoorStream,
  type DoorTarget,
} from './target-map.js';

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

let supervisor: DoorSupervisor | undefined;

export interface DoorSummary {
  enabled: boolean;
  name?: string;
  port?: number;
  hostKey?: string;
  hostKeyFingerprint?: string;
  approvalUrl: string;
  door: DoorSupervisorStatus | { running: false };
  keys: { approved: number; pending: number };
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

/** The door's loopback port range: the first free port in it is taken at enable and kept. */
export const DOOR_PORT_RANGE: readonly [number, number] = [33022, 33121];

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

async function terminalState(state: DoorState): Promise<TerminalState> {
  const store = await readKeyStore(files.keyStore);
  return {
    enabled: state.enabled,
    ...(state.name ? { name: state.name } : {}),
    ...(state.hostKeyFingerprint ? { hostKeyFingerprint: state.hostKeyFingerprint } : {}),
    ...(state.port ? { doorPort: state.port } : {}),
    authorizedFingerprints: store.approved.map((k) => k.fingerprint),
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

/**
 * Render the config from the current process (Node binary, PATH, socket
 * paths may all have changed since the last start), journal, start the
 * target server and the supervised sshd.
 */
async function startDoor(state: DoorState): Promise<DoorState> {
  if (!state.port) throw new Error('the door has no port; run ncl sandboxes remote enable');
  const sshd = findSshd();
  if (!sshd) {
    throw new Error('OpenSSH server (sshd) not found — install the openssh-server package or set NANOCLAW_SSHD');
  }
  if (!executable(ENV_TRAMPOLINE)) throw new Error(`${ENV_TRAMPOLINE} is required to run the door`);
  const refreshed: DoorState = {
    ...state,
    approvalUrl: approvalUrl(),
    socketPath: DEFAULT_SOCKET_PATH,
    hostSocketPath: files.hostSocket,
    path: process.env.PATH ?? '',
    updatedAt: new Date().toISOString(),
  };
  const config = renderSshdConfig({
    port: state.port,
    hostKeyFile: files.hostKey,
    user: os.userInfo().username,
    authorizedKeysCommand: [ENV_TRAMPOLINE, ...resolveEntry('authorized-keys'), DOOR_DIR],
  });
  await fs.promises.writeFile(files.sshdConfig, config, { mode: 0o600 });
  await writeDoorState(files.state, refreshed);
  await startTargetServer(files.hostSocket);
  supervisor ??= new DoorSupervisor({
    sshd,
    configFile: files.sshdConfig,
    port: state.port,
    wrapper: resolveEntry('sshd-wrapper'),
    log: (level, message, data) => log[level](message, data),
  });
  await supervisor.start();
  return refreshed;
}

async function stopDoor(): Promise<void> {
  const running = supervisor;
  supervisor = undefined;
  await running?.stop();
  await stopTargetServer();
}

async function summarize(state: DoorState): Promise<DoorSummary> {
  const store = await readKeyStore(files.keyStore);
  return {
    enabled: state.enabled,
    ...(state.name ? { name: state.name } : {}),
    ...(state.port ? { port: state.port } : {}),
    ...(state.hostKey ? { hostKey: state.hostKey } : {}),
    ...(state.hostKeyFingerprint ? { hostKeyFingerprint: state.hostKeyFingerprint } : {}),
    approvalUrl: state.approvalUrl,
    door: supervisor?.status() ?? { running: false },
    keys: { approved: store.approved.length, pending: store.pending.length },
  };
}

export async function enableDoor(options: { name: string }): Promise<DoorSummary> {
  const name = validateAccountName(options.name);
  const previous = await readDoorState(files.state);
  const hostKey = await ensureHostKey();
  const now = new Date().toISOString();
  const state = await startDoor({
    ...baseState(),
    enabled: true,
    name,
    port: previous?.port ?? (await freeDoorPort()),
    hostKey: hostKey.publicKey,
    hostKeyFingerprint: hostKey.fingerprint,
    enabledAt: previous?.enabled && previous.enabledAt ? previous.enabledAt : now,
  });
  await reportTerminalState(await terminalState(state));
  return summarize(state);
}

export async function disableDoor(): Promise<DoorSummary> {
  await stopDoor();
  const previous = await readDoorState(files.state);
  const state: DoorState = { ...(previous ?? baseState()), enabled: false, updatedAt: new Date().toISOString() };
  await writeDoorState(files.state, state);
  await reportTerminalState(await terminalState(state));
  return summarize(state);
}

export async function doorStatus(): Promise<DoorSummary> {
  return summarize((await readDoorState(files.state)) ?? baseState());
}

export function listDoorKeys(): Promise<KeyStore> {
  return readKeyStore(files.keyStore);
}

/** `text` is a public key line or the path of a file holding one. */
export async function addDoorKey(text: string, label?: string): Promise<ApprovedKey> {
  let line = text.trim();
  const candidate = line.startsWith('~/') ? path.join(os.homedir(), line.slice(2)) : line;
  if (!/\s/.test(line) && fs.existsSync(candidate)) line = await readFile(candidate, 'utf8');
  const key = parsePublicKey(line);
  const store = addApprovedKey(await readKeyStore(files.keyStore), key, label ?? '');
  await writeKeyStore(files.keyStore, store);
  return store.approved.find((k) => k.fingerprint === key.fingerprint)!;
}

export async function approveDoorKey(fingerprint: string, label?: string): Promise<ApprovedKey> {
  const store = approvePendingKey(await readKeyStore(files.keyStore), fingerprint, label);
  await writeKeyStore(files.keyStore, store);
  return store.approved.find((k) => k.fingerprint === fingerprint)!;
}

export async function revokeDoorKey(fingerprint: string): Promise<{ fingerprint: string }> {
  await writeKeyStore(files.keyStore, revokeKey(await readKeyStore(files.keyStore), fingerprint));
  return { fingerprint };
}

onHostStart(async () => {
  const state = await readDoorState(files.state);
  if (!state?.enabled) return;
  try {
    await reportTerminalState(await terminalState(await startDoor(state)));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // The door is optional: a host must still come up without it.
    log.error('Remote terminal door failed to start', { err: error });
  }
});

onHostShutdown(() => stopDoor());
