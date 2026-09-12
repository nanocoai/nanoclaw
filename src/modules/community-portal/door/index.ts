/**
 * The door: an SSH server the host runs in-process on loopback so a remote
 * terminal, relayed by the account link, lands in a code-mode sandbox.
 *
 * `ncl sandboxes remote enable [--name <name>]` generates the host key once,
 * asks the account link to confirm or assign the name, takes a loopback
 * port, starts the server and journals the decision; the host restarts the
 * door on every start while it is enabled. Any username is accepted; the
 * key decides. Approval has two sources — keys the operator approved here
 * and fingerprints the service approved in the browser, applied from each
 * snapshot — and an unknown key waits in-session until one of them arrives.
 *
 * The door lands a terminal through code mode's own sandbox API
 * (code-mode/sandboxes.ts: find, list, create, attach) and holds the bytes
 * itself over the session handle's exec stream; it never reaches into the
 * CLI. Whenever remote access is turned on or off — here, or from the
 * account in the browser — it fires code mode's `onRemoteAccessChanged`
 * hook so other modules learn the host's address.
 *
 * The exported API is what the account link builds on: enableDoor /
 * disableDoor / startDoor / stopDoor / doorStatus, the target map keyed by
 * the loopback source port each relayed stream connects from, the mirror
 * application and the seam. Nothing here imports link code.
 */
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  NEW_SANDBOX_WAKE_WAIT_MS,
  sandboxVerbs,
  type AttachTarget as SandboxAttachTarget,
  type SandboxListRow,
} from '../../../code-mode/sandboxes.js';
import { fireRemoteAccessChanged, type RemoteAccessState } from '../../../code-mode/hooks.js';
import type { Journal } from '../../../community-portal/device-client.js';
import { readJson } from '../../../community-portal/private-file.js';
import { DATA_DIR } from '../../../config.js';
import { onHostStart, onHostShutdown } from '../../../host-lifecycle.js';
import { log } from '../../../log.js';
import * as authority from './authority.js';
import { ensureHostKey } from './host-key.js';
import { parsePublicKey, type ApprovedKey, type KeyStore } from './keys.js';
import type { AttachTarget, SandboxVerbs } from './landing.js';
import { validateAccountName } from './name.js';
import { doorFiles } from './paths.js';
import {
  enableTerminal,
  PENDING_APPROVAL_TTL_MS,
  reportPendingKey,
  reportTerminalState,
  type TerminalState,
} from './report.js';
import { DoorServer, type DoorServerStatus } from './server.js';
import { handleConnection, type SessionDeps } from './session.js';
import { readDoorState, writeDoorState, type DoorState } from './state.js';
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

/** The portal journal the setup wizard writes; its origin names the approval page. */
const PORTAL_JOURNAL = path.join(DATA_DIR, 'community-portal.json');

/** The door's loopback port range: the first free port in it is taken at enable and kept. */
export const DOOR_PORT_RANGE: readonly [number, number] = [33022, 33121];

let server: DoorServer | undefined;
/** The journal the running door was brought up from; undefined while down. */
let running: DoorState | undefined;
let authorityReady = false;
let liveSessions = 0;

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
  /** Absent on a checkout that is not enrolled with a portal. */
  approvalUrl?: string;
  terminal: TerminalJournal;
  door: (DoorServerStatus & { sessions: number }) | { running: false };
  keys: { approved: number; browser: number; pending: number; rooms: number };
}

/**
 * The approval page: `NANOCLAW_TERMINAL_APPROVAL_URL` when set, else the
 * portal origin this checkout enrolled with (the portal routes a signed-in
 * user to the waiting key; the account link supplies the exact page and
 * code when it can). A checkout that never enrolled has none — keys are
 * then approved on the machine.
 */
export async function resolveApprovalUrl(): Promise<string | undefined> {
  const configured = process.env.NANOCLAW_TERMINAL_APPROVAL_URL;
  if (configured) return configured;
  const journal = await readJson<Partial<Journal>>(PORTAL_JOURNAL);
  const origin = journal?.origin;
  if (!origin) return undefined;
  try {
    return new URL(origin).origin;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    log.warn('Remote terminal: the portal origin in the journal is not a URL', { origin });
    return undefined;
  }
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

/** Load the key store (a missing file is an empty store). Nothing is written until a key or the door is. */
async function ensureAuthority(): Promise<void> {
  if (authorityReady) return;
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
  return { version: 1, enabled: false, updatedAt: new Date().toISOString() };
}

/** What other modules hear when remote access flips: on or off, and the host's name and address. */
function remoteAccessState(state: DoorState): RemoteAccessState {
  return {
    enabled: state.enabled,
    ...(state.name ? { name: state.name } : {}),
    ...(state.host ? { host: state.host } : {}),
  };
}

// --- the host's sandbox verbs, as the landing calls them --------------------

const verbs = sandboxVerbs();

function attachTarget(resolved: SandboxAttachTarget): AttachTarget {
  const { handle } = resolved;
  return {
    containerName: resolved.containerName,
    command: resolved.command,
    ...(handle.execStream ? { execStream: (command, options) => handle.execStream!(command, options) } : {}),
    alive: async () => (await handle.status()).phase === 'running',
  };
}

/** The listing a remote `ls` prints: the same columns an operator sees, minus the ids. */
export function renderSandboxListing(rows: SandboxListRow[]): string {
  if (rows.length === 0) return 'no sandboxes yet — connect without a command to create the default one';
  const header = ['SANDBOX', 'STATUS', 'LAST-ACTIVE'];
  const cells = rows.map((r) => [r.sandbox, r.status, r.last_active ?? '-']);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c: string[]) =>
    c
      .map((v, i) => v.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [line(header), ...cells.map(line)].join('\n');
}

async function findOrRefuse(name: string) {
  const group = await verbs.find(name);
  if (!group) throw new Error(`no sandbox '${name}' — create it: ncl sandboxes new --name ${name}`);
  return group;
}

const landingVerbs: SandboxVerbs = {
  async list() {
    const rows = await verbs.list();
    return { names: rows.map((row) => row.sandbox), human: renderSandboxListing(rows) };
  },
  attach: async (name) => attachTarget(await verbs.attach(await findOrRefuse(name))),
  async create(name) {
    // The creation half of `sandboxes new`, then the attach half held here:
    // the door owns the terminal's bytes rather than a client. A brand-new
    // sandbox's first spawn can take a while (image pull, cold runtime).
    const { group, warnings } = await verbs.create({ name });
    for (const warning of warnings) log.warn(warning, { sandbox: name, via: 'remote terminal' });
    return attachTarget(await verbs.attach(group, { wakeWaitMs: NEW_SANDBOX_WAKE_WAIT_MS }));
  },
};

const sessionDeps: SessionDeps = {
  authority: {
    status: (fingerprint) => authority.authorizeStatus(fingerprint, running?.enabled === true),
    openRoom: (request, source) => authority.openRoom(request, source),
    waitForApproval: (fingerprint, waitMs) => authority.waitForApproval(fingerprint, waitMs),
    registerSession: (fingerprint, end) => authority.registerSession(fingerprint, end),
  },
  lookupTarget,
  pending: async (request) => {
    try {
      return await reportPendingKey(request);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // The room still works with an approval from this machine.
      log.warn('Pending terminal key could not be reported', { err: error });
      return {
        ...(request.approvalUrl ? { url: request.approvalUrl } : {}),
        expiresAt: new Date(Date.now() + PENDING_APPROVAL_TTL_MS).toISOString(),
      };
    }
  },
  approvalUrl: () => running?.approvalUrl,
  sandboxes: landingVerbs,
  sessions: {
    count: () => liveSessions,
    track: () => {
      liveSessions += 1;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        liveSessions -= 1;
      };
    },
  },
  log: (level, message, data) => log[level](message, data),
};

/** Listen, then journal from the current process: `enabled` is written only once the door is up. */
async function bringUp(state: DoorState): Promise<DoorState> {
  if (!state.doorPort) throw new Error('the door has no port; run ncl sandboxes remote enable');
  await ensureAuthority();
  const hostKey = await ensureHostKey(files);
  const approvalUrl = await resolveApprovalUrl();
  const refreshed: DoorState = {
    ...state,
    hostKey: hostKey.publicKey,
    hostKeyFingerprint: hostKey.fingerprint,
    ...(approvalUrl ? { approvalUrl } : {}),
    updatedAt: new Date().toISOString(),
  };
  if (!approvalUrl) delete refreshed.approvalUrl;
  running = refreshed;
  server ??= new DoorServer({
    port: state.doorPort,
    hostKey: hostKey.privateKey,
    onConnection: (client, info) => handleConnection(client, info, sessionDeps),
    log: (level, message, data) => log[level](message, data),
  });
  try {
    await server.start();
  } catch (error) {
    running = undefined;
    server = undefined;
    throw error;
  }
  await writeDoorState(files.state, refreshed);
  return refreshed;
}

/**
 * The port the door should be on: the live server's while it runs (a
 * second `enable` keeps the listener, and the free-port probe would see
 * that listener as taken and pick another), else the journaled port when it
 * is still free, else the first free one in the range.
 */
async function doorPortFor(previous: DoorState | undefined): Promise<number> {
  const live = server?.status();
  if (live?.running) return live.port;
  if (previous?.doorPort && (await portFree(previous.doorPort))) return previous.doorPort;
  return freeDoorPort();
}

async function takeDown(): Promise<void> {
  const current = server;
  server = undefined;
  running = undefined;
  await current?.stop();
}

async function summarize(state: DoorState): Promise<DoorSummary> {
  await ensureAuthority();
  const store = authority.keyStore();
  const status = server?.status();
  return {
    enabled: state.enabled,
    ...(state.name ? { name: state.name } : {}),
    ...(state.address ? { address: state.address } : {}),
    ...(state.host ? { host: state.host } : {}),
    ...(state.previousName ? { previousName: state.previousName } : {}),
    ...(state.doorPort ? { doorPort: state.doorPort } : {}),
    ...(state.hostKey ? { hostKey: state.hostKey } : {}),
    ...(state.hostKeyFingerprint ? { hostKeyFingerprint: state.hostKeyFingerprint } : {}),
    ...(state.approvalUrl ? { approvalUrl: state.approvalUrl } : {}),
    terminal: journal(state),
    door: status?.running ? { ...status, sessions: liveSessions } : { running: false },
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
  const hostKey = await ensureHostKey(files);
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
    doorPort: await doorPortFor(previous),
    hostKey: hostKey.publicKey,
    hostKeyFingerprint: hostKey.fingerprint,
    enabledAt: previous?.enabled && previous.enabledAt ? previous.enabledAt : now,
  });
  await reportTerminalState(await terminalState(state));
  await fireRemoteAccessChanged(remoteAccessState(state));
  return summarize(state);
}

export async function disableDoor(): Promise<DoorSummary> {
  await takeDown();
  const previous = await readDoorState(files.state);
  const state: DoorState = { ...(previous ?? baseState()), enabled: false, updatedAt: new Date().toISOString() };
  await writeDoorState(files.state, state);
  await reportTerminalState(await terminalState(state));
  await fireRemoteAccessChanged(remoteAccessState(state));
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
      // The host name follows the name: `<name>.<zone>`, the zone being what
      // follows the old host name's first label.
      const zone = state.host?.split('.').slice(1).join('.');
      const renamed: DoorState = {
        ...state,
        previousName: terminal.previousName ?? state.name,
        name: terminal.name,
        ...(zone ? { host: `${terminal.name}.${zone}` } : {}),
        updatedAt: new Date().toISOString(),
      };
      await writeDoorState(files.state, renamed);
      if (running) {
        running = {
          ...running,
          name: renamed.name,
          previousName: renamed.previousName,
          ...(renamed.host ? { host: renamed.host } : {}),
        };
      }
      log.info('Remote terminal renamed', {
        from: state.name,
        to: terminal.name,
        ...(renamed.host ? { host: renamed.host } : {}),
      });
      await fireRemoteAccessChanged(remoteAccessState(renamed));
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
  // Inert until enabled: nothing is read or written for a host that never
  // opted in, beyond the one journal read.
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
