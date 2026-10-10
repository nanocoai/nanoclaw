import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEVICE_PROOF_HEADER, deviceProof, type DeviceKey } from './device-key.js';
import { portalError } from './errors.js';
import type { InstallIdentity } from './install-identity.js';
import type { CellTicket, LinkLog } from './link.js';
import { readJson, writePrivate } from './private-file.js';
import { processLock } from './process-lock.js';

/**
 * A checkout's client for the community portal's HTTP API. Every request
 * carries the install token as a bearer; device registration and cell tickets
 * add the device proof, nothing else does. The checkout journal
 * (`data/community-portal.json`, mode 0600) holds the portal origin, the
 * cached device id, the perk credentials granted to this device and setup
 * progress. No key and no token live in it: the token comes from the
 * sign-in's account.json and the key from device-key.json, both handed in by
 * the caller.
 */
export interface Redemption {
  deviceId?: string;
  state?: string;
  keyId?: string;
  operationId?: string;
}

export interface Grant {
  id: string;
  perk: string;
  desired: string;
  expiresAt: string;
  redemptions: Redemption[];
}

export interface DeviceState {
  grants: Grant[];
  activations?: Record<string, { enabled?: boolean } | undefined>;
  [key: string]: unknown;
}

export interface Credential {
  keyId: string;
  operationId: string;
  secret?: string;
  resource: { label: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface SetupFlow {
  id: string;
  code: string;
  url: string;
  /** Absent on an anonymous start until the flow is claimed. */
  installId?: string;
  expiresAt: string;
  stage?: string;
  [key: string]: unknown;
}

export interface SlackSetup {
  setupId: string;
  workspaceId: string;
  name: string;
  status: 'creating' | 'received' | 'complete';
  serviceBase?: string;
  app?: { appId: string; appToken: string; botToken?: string };
}

export interface Journal {
  origin?: string;
  deviceId?: string;
  credentials: Record<string, Credential>;
  operations: Record<string, { grantId: string; idempotencyKey: string }>;
  setupFlow?: SetupFlow;
  slackSetup?: SlackSetup;
  reminders?: Partial<Record<string, boolean>>;
  reminderPending?: Partial<Record<string, boolean>>;
}

export interface DeviceRegistration {
  deviceId: string;
  accountId: string;
  installId: string;
}

export interface DeviceClientOptions {
  origin: string;
  /** The private journal. Its lock file is `${file}.lock`. */
  file: string;
  /** The install token and ids from the sign-in's account.json. Absent: unauthenticated requests only. */
  identity?: InstallIdentity;
  /** The machine's device key; needed for `register()` and `ticket()`. */
  deviceKey?: DeviceKey;
  label?: string;
  log?: LinkLog;
  /** Hold the journal lock for the client's lifetime; other writers wait or fail. */
  exclusive?: boolean;
  waitForLockMs?: number;
  signal?: AbortSignal;
  /** Fail instead of creating a journal when none exists. */
  existingOnly?: boolean;
}

export interface CallOptions {
  body?: unknown;
  signal?: AbortSignal;
  /** Add the device proof header (device registration and cell tickets only). */
  proof?: boolean;
}

export const REQUEST_TIMEOUT_MS = 25_000;
/** Fields journals carried before the protocol cutover; dropped on load, never written again. */
const RETIRED_FIELDS = [
  'privateKey',
  'publicKey',
  'wrappingPrivateKey',
  'wrappingPublicKey',
  'registryAccount',
  'installId',
];

export class DeviceClient {
  readonly origin: string;
  /** Set after a sign-in that happened while this client was open (the wizard's not-enrolled path). */
  identity?: InstallIdentity;
  deviceKey?: DeviceKey;
  local!: Journal;
  protected readonly file: string;
  protected readonly label: string;
  protected readonly log: LinkLog;
  protected readonly signal?: AbortSignal;
  private readonly exclusive: boolean;
  private readonly waitForLockMs: number;
  private readonly existingOnly: boolean;
  private releaseLock: (() => void) | null = null;
  private syncing: Promise<DeviceState> | null = null;
  private again = false;
  private stopped = false;

  constructor({
    origin,
    file,
    identity,
    deviceKey,
    label = 'NanoClaw installation',
    log = () => {},
    exclusive = false,
    waitForLockMs = 0,
    signal,
    existingOnly = false,
  }: DeviceClientOptions) {
    const url = new URL(origin);
    const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' && !loopback)
    )
      throw new Error('Portal origin must use HTTPS, except on loopback.');
    this.origin = url.origin;
    this.identity = identity;
    this.deviceKey = deviceKey;
    this.file = file;
    this.label = label;
    this.log = log;
    this.exclusive = exclusive;
    this.waitForLockMs = waitForLockMs;
    this.signal = signal;
    this.existingOnly = existingOnly;
  }

  /** The install token, when signed in. */
  get token(): string | undefined {
    return this.identity?.token;
  }

  /** Load or create the journal. With `exclusive`, waits up to `waitForLockMs` for its lock. */
  async initialize(): Promise<this> {
    if (this.exclusive) {
      const deadline = Date.now() + this.waitForLockMs;
      while (!(this.releaseLock = await processLock(`${this.file}.lock`))) {
        if (Date.now() >= deadline)
          throw portalError(
            'Another setup or receiver owns this installation journal. Retry after it finishes.',
            'journal_busy',
          );
        await sleep(100, undefined, { signal: this.signal });
      }
    }
    try {
      const saved = await readJson<Partial<Journal> & Record<string, unknown>>(this.file);
      if (!saved) {
        if (this.existingOnly)
          throw portalError('This checkout has not been set up with the portal.', 'installation_required');
        this.local = { credentials: {}, operations: {} };
      } else {
        for (const field of RETIRED_FIELDS) delete saved[field];
        this.local = { credentials: {}, operations: {}, ...saved };
      }
      if (this.local.origin && this.local.origin !== this.origin)
        throw new Error('This installation belongs to a different portal. Use a separate state file.');
      this.local.origin = this.origin;
      await this.save();
      return this;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  save(): Promise<void> {
    return writePrivate(this.file, this.local);
  }

  /** A bearer request. Non-2xx responses become errors carrying the portal's code and status. */
  request<T = unknown>(method: string, route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.call<T>(method, route, { body, signal });
  }

  /** Register or re-affirm this machine (idempotent), caching the device id in the journal. */
  async register(): Promise<DeviceRegistration> {
    if (!this.identity) throw portalError('This machine is not signed in to NanoClaw.', 'installation_required');
    const key = this.requireDeviceKey();
    const result = await this.call<DeviceRegistration>('POST', '/api/v1/devices', {
      body: { publicKey: key.publicKeyJwk, label: this.label },
      proof: true,
    });
    if (typeof result.deviceId !== 'string' || !result.deviceId)
      throw portalError('The portal did not return a device id.', 'invalid_response');
    if (this.local.deviceId !== result.deviceId) {
      this.local.deviceId = result.deviceId;
      if (this.file) await this.save();
    }
    return result;
  }

  /** A short-lived ticket for the cell link, proved with the device key. */
  ticket(signal?: AbortSignal): Promise<CellTicket> {
    return this.call<CellTicket>('POST', '/api/v1/cell-ticket', { body: {}, signal, proof: true });
  }

  protected async call<T>(
    method: string,
    route: string,
    { body, signal = this.signal, proof = false }: CallOptions = {},
  ): Promise<T> {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.identity) headers.authorization = `Bearer ${this.identity.token}`;
    if (proof) headers[DEVICE_PROOF_HEADER] = deviceProof(this.requireDeviceKey());
    const response = await fetch(`${this.origin}${route}`, {
      method,
      headers,
      ...(raw ? { body: raw } : {}),
      signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]),
      redirect: 'error',
    });
    const text = await response.text();
    let result: T & { error?: string; message?: string };
    try {
      result = (text ? JSON.parse(text) : {}) as T & { error?: string; message?: string };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw Object.assign(
        new Error(`The portal returned an unreadable response (${response.status}).`, { cause: error }),
        {
          code: 'invalid_response',
          status: response.status,
        },
      );
    }
    if (!response.ok)
      throw portalError(
        result.message || result.error || `The portal request failed (${response.status}).`,
        result.error,
        response.status,
      );
    return result;
  }

  private requireDeviceKey(): DeviceKey {
    if (!this.deviceKey)
      throw portalError('This machine has no device key. Run the portal setup step.', 'device_key_required');
    return this.deviceKey;
  }

  /** Bring local credentials in line with the account's grants. Coalesces overlapping calls. */
  reconcile(): Promise<DeviceState> {
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    this.syncing = this.sync().finally(() => {
      this.syncing = null;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.reconcile().catch((error: unknown) => this.log({ event: 'retry', code: errorCodeOf(error) }));
      }
    });
    return this.syncing;
  }

  protected async sync(): Promise<DeviceState> {
    const state = await this.request<DeviceState>('GET', '/api/v1/device/state');
    const active = new Set(
      state.grants
        .filter((grant) => grant.desired === 'active' && Date.parse(grant.expiresAt) > Date.now())
        .map((grant) => grant.perk),
    );
    for (const perk of Object.keys(this.local.credentials)) {
      if (active.has(perk)) continue;
      delete this.local.credentials[perk];
      delete this.local.operations[perk];
      await this.save();
      this.log({ event: 'removed', perk });
    }
    for (const grant of state.grants) {
      if (!active.has(grant.perk)) continue;
      const redemption = grant.redemptions.find((r) => r.deviceId === this.local.deviceId);
      if (redemption && ['REVOKING', 'REVOKED'].includes(redemption.state ?? '')) continue;
      let credential = this.local.credentials[grant.perk];
      if (credential && redemption?.keyId === credential.keyId && redemption.operationId === credential.operationId) {
        if (redemption.state === 'DELIVERED') continue;
      } else {
        const previous = this.local.operations[grant.perk];
        if (!previous || previous.grantId !== grant.id) {
          this.local.operations[grant.perk] = {
            grantId: grant.id,
            idempotencyKey: randomBytes(24).toString('base64url'),
          };
          await this.save();
        }
        const result = await this.request<Credential>('POST', `/api/v1/grants/${grant.perk}/redeem`, {
          idempotencyKey: this.local.operations[grant.perk].idempotencyKey,
        });
        if (!result.secret) {
          this.log({ event: 'local_credential_missing', perk: grant.perk });
          continue;
        }
        credential = this.local.credentials[grant.perk] = result;
        await this.save();
        this.log({ event: 'stored', perk: grant.perk, resource: result.resource.label });
      }
      await this.request('POST', `/api/v1/grants/${grant.perk}/ack`, {
        operationId: credential.operationId,
        keyId: credential.keyId,
      });
    }
    return state;
  }

  /** Wait for an in-flight reconcile, then release the journal lock. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.syncing) await this.syncing.catch(() => undefined);
    if (this.releaseLock) {
      this.releaseLock();
      this.releaseLock = null;
    }
  }
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code : 'unavailable';
}
