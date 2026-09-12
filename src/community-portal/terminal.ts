import path from 'node:path';
import { DeviceClient, type Journal } from './device-client.js';
import { readDeviceKey } from './device-key.js';
import { errorCode } from './errors.js';
import { readInstallIdentity } from './install-identity.js';
import type { LinkLog } from './link.js';
import { readJson } from './private-file.js';

/**
 * The remote-terminal section of the account contract, as the host speaks
 * it: the door reports its state over a bearer route (`PUT
 * /api/v1/terminal/host`) on every start, every fifteen minutes and on
 * disable, and journals it under `terminal` in data/community-portal.json so
 * the running host knows whether to announce the `ssh` cap and which loopback
 * port to pipe streams to. Approvals and revocations come back down the link
 * inside every perks snapshot's `terminal` section: the keys the door
 * honours, the pairings still waiting and the sandboxes with an address.
 * Public keys never travel here; fingerprints do.
 */
export interface TerminalKey {
  fingerprint: string;
  keyType?: string;
  label?: string;
  approvedAt?: string;
  installedAt?: string;
  source?: { ip?: string };
}

export interface TerminalPendingKey {
  fingerprint: string;
  keyType?: string;
  code?: string;
  source?: { ip?: string; port?: number };
  at?: string;
  expiresAt?: string;
}

export interface TerminalSandbox {
  name: string;
  address?: string;
  createdAt?: string;
}

/** The mirror's `terminal` section; absent while the account never enabled remote access. */
export interface TerminalSnapshot {
  enabled: boolean;
  name?: string;
  /** Set for a while after a rename in the browser. */
  previousName?: string;
  renamedAt?: string;
  address?: string;
  deviceId?: string;
  hostKeyFingerprint?: string;
  updatedAt?: string;
  keys: TerminalKey[];
  pending: TerminalPendingKey[];
  sandboxes: TerminalSandbox[];
}

/** What `remote enable|disable` journals (`terminal` in data/community-portal.json). */
export interface JournalTerminal {
  enabled: boolean;
  name?: string;
  hostKeyFingerprint?: string;
  doorPort?: number;
  updatedAt: string;
}

/** The door's state as its supervisor knows it. */
export interface TerminalState {
  enabled: boolean;
  name?: string;
  hostKey?: string;
  hostKeyFingerprint?: string;
  doorPort?: number;
  /** The fingerprints the door currently honours. */
  authorizedFingerprints?: string[];
}

/** Body of `PUT /api/v1/terminal/host`; the service answers with its own view of `enabled`. */
export interface TerminalReport {
  enabled: boolean;
  hostKey?: string;
  doorPort?: number;
  authorizedFingerprints: string[];
}

export interface TerminalReportResult {
  ok: boolean;
  /** The service's view: `false` here disables; `true` never re-enables. */
  enabled: boolean;
}

/**
 * Body of `POST /api/v1/terminal/enable`. The name is omitted when the
 * service should assign one, and ignored once the account has one; the host
 * key is the door's public key line.
 */
export interface TerminalEnableRequest {
  name?: string;
  hostKey?: string;
}

export interface TerminalEnableResult {
  /** The name the account now carries, assigned or confirmed by the service. */
  name: string;
  /** The machine's address. */
  address?: string;
  /** `SHA256:<base64 without padding>` of the host key the service holds; null when it holds none. */
  hostKeyFingerprint?: string | null;
  /** The host name to connect to, when the service composes it. */
  host?: string;
}

/** Body of `POST /api/v1/terminal/keys/pending`: a key waiting in the door's waiting room and where it came from. */
export interface TerminalPendingRequest {
  /** `SHA256:<base64 without padding>`; must match the blob. */
  fingerprint: string;
  keyType: string;
  /** The key blob as the server hands it to the door, or the full public key line. */
  publicKey: string;
  source: { ip: string; port: number };
  at?: string;
}

export interface TerminalPendingResult {
  /** The short code the approval page asks for, as `XXXX-XXXX`. */
  code?: string;
  url: string;
  expiresAt: string;
}

/** Answer of `POST /api/v1/terminal/sandboxes`: the sandbox's own address. */
export interface TerminalSandboxResult {
  name: string;
  address: string;
  host?: string;
}

export interface ReportTerminalOptions {
  root?: string;
  homeDir?: string;
  signal?: AbortSignal;
  log?: LinkLog;
  /** How long to wait for the journal lock held by a reconcile or the wizard. */
  waitForLockMs?: number;
  now?: () => number;
}

export interface ReportTerminalOutcome {
  /** The journal's `terminal` section was written. */
  journaled: boolean;
  /** The service accepted the report. */
  reported: boolean;
  code?: string;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const opt = <T>(key: string, value: T | undefined): Record<string, T> =>
  value === undefined ? {} : ({ [key]: value } as Record<string, T>);

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    : [];
}

function sourceOf(value: unknown): { ip?: string; port?: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { ip, port } = value as { ip?: unknown; port?: unknown };
  return { ...opt('ip', str(ip)), ...opt('port', Number.isInteger(port) ? (port as number) : undefined) };
}

/** The `terminal` section of a perks snapshot, or undefined when the mirror carries none. */
export function terminalSnapshotOf(snapshot: unknown): TerminalSnapshot | undefined {
  const terminal = (snapshot as { terminal?: unknown } | null | undefined)?.terminal;
  if (typeof terminal !== 'object' || terminal === null) return undefined;
  const t = terminal as Record<string, unknown>;
  const keys: TerminalKey[] = [];
  for (const k of records(t.keys)) {
    const fingerprint = str(k.fingerprint);
    if (!fingerprint) continue;
    const source = sourceOf(k.source);
    keys.push({
      fingerprint,
      ...opt('keyType', str(k.keyType)),
      ...opt('label', str(k.label)),
      ...opt('approvedAt', str(k.approvedAt)),
      ...opt('installedAt', str(k.installedAt)),
      ...opt('source', source && { ...opt('ip', source.ip) }),
    });
  }
  const pending: TerminalPendingKey[] = [];
  for (const p of records(t.pending)) {
    const fingerprint = str(p.fingerprint);
    if (!fingerprint) continue;
    pending.push({
      fingerprint,
      ...opt('keyType', str(p.keyType)),
      ...opt('code', str(p.code)),
      ...opt('source', sourceOf(p.source)),
      ...opt('at', str(p.at)),
      ...opt('expiresAt', str(p.expiresAt)),
    });
  }
  const sandboxes: TerminalSandbox[] = [];
  for (const s of records(t.sandboxes)) {
    const name = str(s.name);
    if (!name) continue;
    sandboxes.push({ name, ...opt('address', str(s.address)), ...opt('createdAt', str(s.createdAt)) });
  }
  return {
    enabled: t.enabled === true,
    ...opt('name', str(t.name)),
    ...opt('previousName', str(t.previousName)),
    ...opt('renamedAt', str(t.renamedAt)),
    ...opt('address', str(t.address)),
    ...opt('deviceId', str(t.deviceId)),
    ...opt('hostKeyFingerprint', str(t.hostKeyFingerprint)),
    ...opt('updatedAt', str(t.updatedAt)),
    keys,
    pending,
    sandboxes,
  };
}

/** The report body for a door state. */
export function terminalReportOf(state: TerminalState): TerminalReport {
  return {
    enabled: state.enabled,
    ...opt('hostKey', state.hostKey),
    ...opt('doorPort', state.doorPort),
    authorizedFingerprints: [...(state.authorizedFingerprints ?? [])],
  };
}

/** The journal entry for a door state. */
export function journalTerminalOf(state: TerminalState, now: () => number = Date.now): JournalTerminal {
  return {
    enabled: state.enabled,
    ...opt('name', state.name),
    ...opt('hostKeyFingerprint', state.hostKeyFingerprint),
    ...opt('doorPort', state.doorPort),
    updatedAt: new Date(now()).toISOString(),
  };
}

export interface CheckoutClientOptions {
  root?: string;
  homeDir?: string;
  log?: LinkLog;
  signal?: AbortSignal;
}

/**
 * A bearer client for this checkout from its saved identity (the journal's
 * origin and device id, the sign-in's install token, and the device key when
 * the machine has one), or undefined while the checkout is not set up with
 * the account service. Takes no journal lock: for requests, not for writes.
 */
export async function checkoutClient({
  root = process.cwd(),
  homeDir,
  log = () => {},
  signal,
}: CheckoutClientOptions = {}): Promise<DeviceClient | undefined> {
  const file = path.join(root, 'data/community-portal.json');
  const journal = await readJson<Partial<Journal>>(file);
  if (!journal?.origin || !journal.deviceId) return undefined;
  const identity = await readInstallIdentity({ homeDir });
  if (!identity) return undefined;
  const deviceKey = readDeviceKey({ homeDir }) ?? undefined;
  return new DeviceClient({ origin: journal.origin, file, identity, deviceKey, log, signal });
}

/**
 * Journal the door's state, then report it to the account service with the
 * install token. Never throws: a checkout that is not set up with the portal,
 * a busy journal, or an unreachable service each come back as an outcome
 * with a code, because the door must work locally regardless and the running
 * host repeats the report on its own schedule.
 */
export async function reportTerminalState(
  state: TerminalState,
  {
    root = process.cwd(),
    homeDir,
    signal,
    log = () => {},
    waitForLockMs = 5_000,
    now = Date.now,
  }: ReportTerminalOptions = {},
): Promise<ReportTerminalOutcome> {
  const file = path.join(root, 'data/community-portal.json');
  const saved = await readJson<Partial<Journal>>(file);
  if (!saved?.origin || !saved.deviceId) return { journaled: false, reported: false, code: 'installation_required' };
  const identity = await readInstallIdentity({ homeDir });
  const client = new DeviceClient({
    origin: saved.origin,
    file,
    identity: identity ?? undefined,
    exclusive: true,
    existingOnly: true,
    waitForLockMs,
    signal,
    log,
  });
  let journaled = false;
  try {
    await client.initialize();
    client.local.terminal = journalTerminalOf(state, now);
    await client.save();
    journaled = true;
    if (!identity) return { journaled, reported: false, code: 'installation_required' };
    await client.reportTerminal(terminalReportOf(state), signal);
    return { journaled, reported: true };
  } catch (error) {
    const code = errorCode(error);
    log({ event: 'terminal_report_failed', code });
    return { journaled, reported: false, code };
  } finally {
    await client.stop();
  }
}
