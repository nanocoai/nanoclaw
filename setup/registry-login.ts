/**
 * Sign-in driver for the gated agent-image path. Spawned by
 * `setup/registry-login.sh` under inherited stdio.
 *
 * Two ways in, one outcome: an opaque account token on disk, which the docker
 * credential helper later exchanges for a short-lived registry password.
 *
 *   device flow      OAuth 2.0 device authorization grant (RFC 8628) against
 *                    WorkOS AuthKit — for a human at a terminal.
 *   enrollment code  An operator-issued code. This is the CI path, the fleet
 *                    path, and the escape hatch for anyone who declines social
 *                    login. It needs no identity provider at all, which is what
 *                    keeps the whole stack testable before a tenant exists.
 *
 * WorkOS contract (https://workos.com/docs/authkit/cli-auth and
 * https://workos.com/docs/reference/authkit/cli-auth): both endpoints take
 * `application/x-www-form-urlencoded` bodies, the device response carries
 * `device_code` / `user_code` / `verification_uri` / `verification_uri_complete`
 * / `expires_in` / `interval`, and **no client secret is involved** — the device
 * grant is a public-client flow, so the only WorkOS value this file ever holds
 * is a client id. Errors come back as HTTP 400 with `{error, error_description}`.
 *
 * The device-code card prints as plain stdout, never a status block: no runner
 * in this tree renders a block mid-stream, so a card emitted that way would be
 * swallowed. Only the terminal result is a status block.
 *
 * Files written, all under a 0700 directory:
 *   ~/.config/nanoclaw/account.json        the account record + token (0600)
 *   ~/.config/nanoclaw/registry-auth.json  the credential helper's view (0600)
 *   ~/.config/nanoclaw/host-id             per-machine id for the mint log (0600)
 *
 * The helper reads files rather than the environment because docker spawns it
 * with an environment we do not control. `registry-auth.json` is its contract,
 * not ours — `{ broker_url, registry, token }`, exactly those names.
 */
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline/promises';
import { setTimeout as sleep } from 'timers/promises';
import { pathToFileURL } from 'url';

import * as p from '@clack/prompts';

import { installCredentialHelper } from './install-cred-helper.js';
import { readEnvFile } from '../src/env.js';
import { DEFAULT_BROKER_URL, readAgentImagePin, writeImageSource } from './lib/registry-state.js';
import { commandExists, isHeadless, isWSL } from './platform.js';
import { emitStatus } from './status.js';

/** Broker base. Overridable so a fork, a staging stack, or a test can retarget. */

/**
 * WorkOS's shared endpoints, not a per-tenant domain — the tenant is identified
 * entirely by the client id, which is why these can be constants and the client
 * id cannot.
 */
const DEFAULT_DEVICE_ENDPOINT = 'https://api.workos.com/user_management/authorize/device';
const DEFAULT_TOKEN_ENDPOINT = 'https://api.workos.com/user_management/authenticate';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

const ENV = {
  api: 'NANOCLAW_REGISTRY_API',
  token: 'NANOCLAW_REGISTRY_TOKEN',
  enrollCode: 'NANOCLAW_REGISTRY_ENROLL_CODE',
  clientId: 'NANOCLAW_WORKOS_CLIENT_ID',
  deviceEndpoint: 'NANOCLAW_WORKOS_DEVICE_ENDPOINT',
  tokenEndpoint: 'NANOCLAW_WORKOS_TOKEN_ENDPOINT',
} as const;

const CONFIG_DIR = path.join(os.homedir(), '.config', 'nanoclaw');
const ACCOUNT_FILE = path.join(CONFIG_DIR, 'account.json');
const REGISTRY_AUTH_FILE = path.join(CONFIG_DIR, 'registry-auth.json');
const HOST_ID_FILE = path.join(CONFIG_DIR, 'host-id');

/** Ceiling on a device wait regardless of what the provider's `expires_in` says. */
const MAX_DEVICE_WAIT_MS = 900_000;
const HTTP_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 8_000;
/**
 * RFC 8628 §3.5 puts the `slow_down` step at 5 seconds. WorkOS documents a
 * smaller one; the spec's is compliant with both and costs a few seconds of
 * latency at worst.
 */
const SLOW_DOWN_STEP_MS = 5_000;
/** Consecutive transport failures tolerated mid-poll before giving up. */
const MAX_POLL_TRANSPORT_FAILURES = 10;

/** Exit code meaning "nothing was signed in, and that is fine" — see the wrapper. */
const EXIT_SKIPPED = 2;

/**
 * True when `setup/auto.ts` spawned us, which means there is a UI in front of
 * the user already reporting the outcome. Everything this driver would say
 * about success is then a second copy of it, printed in a different voice.
 *
 * Standalone runs get the confirmation, because there is nothing else to give
 * it. The variable is set at the spawn site, not in `.env` — it describes this
 * invocation, not the install.
 */
const SPAWNED_BY_WIZARD = process.env.NANOCLAW_SETUP_WIZARD === '1';

/**
 * Whether anything is parsing our stdout. Set from `--non-interactive` / no TTY.
 *
 * This driver is the one setup surface that is not a `--step`: it needs a TTY
 * and minutes of deliberate silence, so `setup/auto.ts` runs it through
 * `runInheritScript` and reads only its exit code. Nothing in the tree parses a
 * REGISTRY_LOGIN block — so on the interactive path emitting one prints machine
 * syntax into the middle of a conversation with a human.
 *
 * Still emitted when there is no human: `--code` and the token-from-environment
 * paths are the CI surfaces, and a caller wrapping those has nothing else
 * structured to read.
 */
let machineReadable = false;

/** `emitStatus`, minus the case where the only reader is a person. */
function emitLoginStatus(fields: Parameters<typeof emitStatus>[1]): void {
  if (machineReadable) emitStatus('REGISTRY_LOGIN', fields);
}

export interface AccountCredential {
  version: 1;
  /** The broker this token is valid against; a token is meaningless without it. */
  api: string;
  account_id: string;
  email?: string;
  /** Opaque bearer, hashed at rest by the broker. Never a JWT, never parsed here. */
  token: string;
  /** Registry hostname this token is good for, once known. */
  registry?: string;
  entitlements: string[];
  created_at: string;
}

/**
 * A sign-in, plus the one piece of account state that is not part of the
 * credential. `emailUpdates` is `null` when this account has never been asked
 * about product email, which is what makes the prompt fire exactly once
 * per account rather than once per machine.
 *
 * Deliberately not a field on `AccountCredential`: that shape is written to
 * disk, and a marketing preference has no business in a credential file.
 */
interface EnrollResult {
  credential: AccountCredential;
  emailUpdates: boolean | null;
}

/** Sign-in failure with a sentence for the user and, where possible, a way out. */
class LoginError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'LoginError';
  }
}

type LoginMethod = 'device' | 'code' | 'token';

interface Options {
  interactive: boolean;
  /** Sign in again even when a valid credential is already on disk. */
  force: boolean;
  api?: string;
  code?: string;
}

// ---------------------------------------------------------------------------
// Small parsing helpers. Every remote body is `unknown` until proven otherwise.

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// HTTP

interface HttpRequest {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

interface HttpResult {
  status: number;
  body: Record<string, unknown> | undefined;
}

/**
 * Throws only on transport failure — an HTTP error status is data here, because
 * the device grant signals `authorization_pending` as a 400 and that is the
 * normal case, not an exception.
 */
async function http(url: string, req: HttpRequest, timeoutMs: number): Promise<HttpResult> {
  const res = await fetch(url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = text ? JSON.parse(text) : undefined;
    body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    // A proxy's HTML error page, most likely. The status still tells us enough.
  }
  return { status: res.status, body };
}

function form(fields: Record<string, string>): HttpRequest {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(fields).toString(),
  };
}

function json(payload: unknown, bearer?: string): HttpRequest {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(payload),
  };
}

/**
 * The probe is a read, and both the broker's route table and the API Gateway
 * stack declare it `GET /v1/session/probe`. A POST routes to nothing: the
 * gateway 404s before the Lambda runs, `probeSession` reads that as
 * "unreachable", and an expired or revoked token then looks like an offline
 * broker instead of a signal to sign in again.
 */
function bearerGet(bearer: string): HttpRequest {
  return {
    method: 'GET',
    headers: { accept: 'application/json', authorization: `Bearer ${bearer}` },
  };
}

// ---------------------------------------------------------------------------
// On-disk state

/**
 * Atomic, owner-only write. `writeFileSync`'s mode argument applies only when
 * the file is created, so a pre-existing world-readable temp file would keep
 * its mode — hence the explicit chmod before the rename rather than after.
 */
function writeSecretFile(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(file), 0o700);
  } catch {
    // Pre-existing directory we don't own the mode of. The file mode below is
    // the one that actually protects the token.
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/**
 * A random per-machine id for the broker's mint log. Deliberately **not**
 * `data/install-id`: that one is the diagnostics identifier, and reusing it
 * would mean opting out of diagnostics no longer de-identifies you.
 */
function ensureHostId(): string {
  const existing = str(readFileOrUndefined(HOST_ID_FILE));
  if (existing) return existing;
  const id = randomBytes(16).toString('hex');
  try {
    writeSecretFile(HOST_ID_FILE, `${id}\n`);
  } catch {
    // Not worth failing a sign-in over; the id is a telemetry join key.
  }
  return id;
}

function readFileOrUndefined(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
}

function readAccountCredential(): AccountCredential | undefined {
  const raw = readFileOrUndefined(ACCOUNT_FILE);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log(`Ignoring an unreadable credential at ${ACCOUNT_FILE}; signing in again.`);
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const o = parsed as Record<string, unknown>;
  const token = str(o.token);
  const accountId = str(o.account_id);
  if (!token || !accountId) return undefined;
  return {
    version: 1,
    api: str(o.api) ?? resolveApiBase(),
    account_id: accountId,
    email: str(o.email),
    token,
    registry: str(o.registry),
    entitlements: strings(o.entitlements),
    created_at: str(o.created_at) ?? new Date().toISOString(),
  };
}

/**
 * The registry hostname the token is good for. The credential helper keys on it
 * and refuses to answer for any other host, so a wrong value costs a failed
 * pull rather than a leaked token. The broker is authoritative; the pinned
 * image reference is the fallback, since it names the same registry by
 * construction. A bare `org/image` ref names Docker Hub, not a host, so it is
 * rejected rather than read as one.
 */
function resolveRegistryHost(fromBroker: string | undefined): string | undefined {
  if (fromBroker) {
    return fromBroker.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0].toLowerCase();
  }
  const first = readAgentImagePin()?.split('/')[0];
  return first && (first.includes('.') || first.includes(':')) ? first.toLowerCase() : undefined;
}

/**
 * Two files, one token. `account.json` is the record a human reads;
 * `registry-auth.json` is the credential helper's contract — its field names,
 * kept minimal because the helper runs with no repo on its path and no cwd
 * worth trusting. Any cached password the helper stashed there is dropped: a
 * new token invalidates it.
 */
function persistCredential(cred: AccountCredential): void {
  const record: AccountCredential = { ...cred, registry: resolveRegistryHost(cred.registry) };
  writeSecretFile(ACCOUNT_FILE, `${JSON.stringify(record, null, 2)}\n`);
  ensureHostId();
  writeSecretFile(
    REGISTRY_AUTH_FILE,
    `${JSON.stringify({ version: 1, broker_url: record.api, registry: record.registry ?? '', token: record.token }, null, 2)}\n`,
  );
  if (!record.registry) {
    console.log('   Note: no registry is pinned yet, so the image pull will have nothing to authenticate against.');
  }
  wireDockerCredentialHelper(record.registry);

  // Record that this install pulls, HERE rather than at the call sites.
  //
  // There are four ways to finish a sign-in — a token or an enrolment code
  // from the environment, a code typed at the prompt, and the browser flow —
  // and every one ends up in this function. Setting it at the call sites means
  // setting it in four places and missing one, which is exactly what happened:
  // a successful non-interactive sign-in left .env saying "build here", so the
  // container step built locally and the pull silently never happened.
  //
  // setup/auto.ts also writes this before launching the sign-in, for its own
  // resume-safety reasons. Both are idempotent; --opt-out reverses either.
  writeImageSource('hardened');
}

/**
 * Point docker at the helper, here, because holding a token and not being able
 * to spend it is indistinguishable from not being signed in: docker only calls
 * the helper for a host listed in its own `credHelpers`, so without this the
 * pull goes out anonymous and fails against a private registry.
 *
 * Deliberately after the credential is on disk (the installer reads the
 * registry back out of it), and deliberately non-fatal — a sign-in that
 * succeeded is worth keeping even when we cannot write to a bin directory, and
 * `--step registry -- --status` reports the gap.
 */
function wireDockerCredentialHelper(registry?: string): void {
  if (!registry) return;
  try {
    const result = installCredentialHelper({ registryHost: registry });
    if (!result.onPath) {
      console.log(`   Note: ${path.dirname(result.helperPath)} is not on PATH, so docker will not find the helper.`);
    }
  } catch (err) {
    console.log(`   Note: couldn't point docker at the credential helper (${message(err)}).`);
    console.log('   Run `pnpm exec tsx setup/install-cred-helper.ts` once that is fixed.');
  }
}

// ---------------------------------------------------------------------------
// Broker

function resolveApiBase(override?: string): string {
  // process.env, then .env, then the default — same order and same key as
  // setup/lib/registry-state.ts, which states outright that the two must stay
  // in lockstep. A process.env-only read diverges the moment an operator sets
  // the key in .env.
  const raw = override ?? str(process.env[ENV.api]) ?? str(readEnvFile([ENV.api])[ENV.api]) ?? DEFAULT_BROKER_URL;
  return raw.replace(/\/+$/, '');
}

interface ClientRecord {
  os: string;
  arch: string;
  nanoclaw_version: string;
  host_id: string;
}

function clientRecord(): ClientRecord {
  let version = 'unknown';
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
    version = str((pkg as Record<string, unknown>)?.version) ?? 'unknown';
  } catch {
    // Running from somewhere other than the checkout root. Not worth failing over.
  }
  return { os: process.platform, arch: process.arch, nanoclaw_version: version, host_id: ensureHostId() };
}

type ProbeState =
  | { state: 'ok'; account_id: string; email?: string; registry?: string; entitlements: string[] }
  | { state: 'unauthorized' }
  | { state: 'unreachable'; reason: string };

/** Is this token still good? Used for idempotence, so it must not be fatal. */
async function probeSession(api: string, token: string): Promise<ProbeState> {
  let res: HttpResult;
  try {
    res = await http(`${api}/v1/session/probe`, bearerGet(token), PROBE_TIMEOUT_MS);
  } catch (err) {
    return { state: 'unreachable', reason: message(err) };
  }
  if (res.status === 401 || res.status === 403) return { state: 'unauthorized' };
  if (res.status !== 200) return { state: 'unreachable', reason: `HTTP ${res.status}` };
  const accountId = str(res.body?.account_id);
  if (!accountId) return { state: 'unreachable', reason: 'the service returned no account id' };
  return {
    state: 'ok',
    account_id: accountId,
    email: str(res.body?.email),
    registry: str(res.body?.registry),
    entitlements: readEntitlements(res.body),
  };
}

type EnrollBody =
  | { method: 'code'; code: string; client: ClientRecord }
  | { method: 'idp'; provider: 'workos'; access_token: string; client: ClientRecord };

/**
 * The broker's wire shape, which is not this file's storage shape.
 *
 * `install_id` is top-level and mandatory there: it is the idempotency key that
 * stops a resumed setup burning a second use of a single-use enrollment code,
 * so it cannot stay buried in the client record. The IdP path names the bearer
 * `workos_token` because the field is provider-specific by design, while
 * `method`/`provider` are ours and simply ignored — sending them costs nothing
 * and keeps the request self-describing in a log.
 */
function enrollWire(body: EnrollBody): Record<string, unknown> {
  const common = { ...body, install_id: body.client.host_id };
  return body.method === 'idp' ? { ...common, workos_token: body.access_token } : common;
}

async function enroll(api: string, body: EnrollBody): Promise<EnrollResult> {
  let res: HttpResult;
  try {
    res = await http(`${api}/v1/enroll`, json(enrollWire(body)), HTTP_TIMEOUT_MS);
  } catch (err) {
    throw new LoginError(
      `Couldn't reach the NanoClaw account service at ${api}: ${message(err)}`,
      `Check your network, then re-run. Point ${ENV.api} elsewhere if you run your own.`,
    );
  }

  // 201 is a brand-new account and 200 an existing one relinking — the common
  // case is the created one, so treating anything but 200 as a failure would
  // reject almost every real first sign-in.
  if (res.status !== 200 && res.status !== 201) throw enrollFailure(api, body.method, res);

  const token = str(res.body?.token) ?? str(res.body?.pull_token);
  const accountId = str(res.body?.account_id);
  if (!token || !accountId) {
    throw new LoginError('The account service accepted the sign-in but returned no usable credential.');
  }
  return {
    credential: {
      version: 1,
      api,
      account_id: accountId,
      email: str(res.body?.email),
      token,
      registry: str(res.body?.registry),
      entitlements: readEntitlements(res.body),
      created_at: new Date().toISOString(),
    },
    // Anything other than a real boolean means "never asked" — including an
    // older broker that has no idea what this field is.
    emailUpdates: typeof res.body?.email_updates === 'boolean' ? res.body.email_updates : null,
  };
}

/**
 * `entitlements` is this file's name; the broker calls the same thing `perks`
 * and, on the probe route, returns them as objects carrying quota alongside the
 * name. Read all three shapes — the alternative is an empty entitlement list
 * that silently overwrites a good one on the next re-run.
 */
function readEntitlements(body: Record<string, unknown> | undefined): string[] {
  const raw = body?.entitlements ?? body?.perks;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => (typeof v === 'string' ? v : str((v as Record<string, unknown> | null)?.perk)))
    .filter((v): v is string => Boolean(v));
}

/** Map the broker's error code to something the operator can act on. */
function idpRejectionHint(code?: string): string {
  switch (code) {
    case 'email_unverified':
      return 'Verify your email address with your identity provider, then sign in again.';
    case 'email_missing':
      return 'Your identity provider returned no email address. An email is required to create an account.';
    case 'unknown_user':
      return 'That account no longer exists at your identity provider.';
    case 'token_expired':
      return 'The sign-in took too long. Run this again — the code is valid for 5 minutes.';
    case 'account_unavailable':
      return 'This account is suspended. Contact whoever administers your NanoClaw account.';
    case 'identity_provider_unconfigured':
      return 'Browser sign-in is not enabled on this deployment. Use an enrollment code instead.';
    default:
      return 'The identity provider approved you, but the account service would not accept it.';
  }
}

function enrollFailure(api: string, method: 'code' | 'idp', res: HttpResult): LoginError {
  const detail = str(res.body?.error_description) ?? str(res.body?.error) ?? `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 403) {
    return method === 'code'
      ? new LoginError(
          'That enrollment code was not accepted.',
          'Codes are single-use and expire. Ask whoever issued it for a fresh one.',
        )
      : new LoginError(
          `The account service rejected the sign-in (${detail}).`,
          // The broker sends a specific reason and it is the only thing that
          // makes this diagnosable -- collapsing every 401/403 into one generic
          // sentence turns a five-second fix into a log-diving session.
          idpRejectionHint(str(res.body?.error)),
        );
  }
  if (res.status === 404) {
    return new LoginError(
      `${api} has no enrollment endpoint.`,
      `Set ${ENV.api} to the right base URL, or skip sign-in and build the image locally.`,
    );
  }
  if (res.status === 429) {
    return new LoginError(
      'The account service is rate-limiting sign-ins right now.',
      'Wait a few minutes and re-run. Nothing is wrong with your account.',
    );
  }
  if (res.status >= 500) {
    return new LoginError(`The account service is unavailable (${detail}).`, 'Try again shortly.');
  }
  return new LoginError(`Sign-in was refused: ${detail}`);
}

// ---------------------------------------------------------------------------
// Device flow

interface IdpConfig {
  clientId: string;
  deviceEndpoint: string;
  tokenEndpoint: string;
}

/**
 * A client id is public, but it is still deployment state — a fork pointing at
 * its own broker must not inherit ours — so it is never committed. Environment
 * first, then ask the broker. Any failure means "no browser sign-in here",
 * never an error: the enrollment-code path still works, and that is the whole
 * reason it exists.
 */
/**
 * Three outcomes, not two.
 *
 * "No identity provider" and "that URL is not a NanoClaw registry" are different
 * problems with different fixes, and collapsing them is how a wrong
 * NANOCLAW_REGISTRY_API presents as "browser authentication is not configured" — which
 * sends someone looking in entirely the wrong place. The default host resolves
 * and answers 404 from the marketing site, so "unreachable" is not a safe proxy
 * for "misconfigured" either.
 */
type BrokerProbe =
  | { kind: 'idp'; config: IdpConfig }
  | { kind: 'no-idp' }
  | { kind: 'not-a-broker'; detail: string };

async function probeBroker(api: string): Promise<BrokerProbe> {
  const fromEnv = str(process.env[ENV.clientId]);
  if (fromEnv) {
    return {
      kind: 'idp',
      config: {
        clientId: fromEnv,
        deviceEndpoint: str(process.env[ENV.deviceEndpoint]) ?? DEFAULT_DEVICE_ENDPOINT,
        tokenEndpoint: str(process.env[ENV.tokenEndpoint]) ?? DEFAULT_TOKEN_ENDPOINT,
      },
    };
  }

  let res;
  try {
    res = await http(`${api}/v1/auth-config`, { method: 'GET', headers: { accept: 'application/json' } }, PROBE_TIMEOUT_MS);
  } catch (err) {
    return { kind: 'not-a-broker', detail: message(err) };
  }

  // A real broker answers this route as JSON either way: 200 when a device flow
  // is configured, 503 with device_flow_available:false when it is not. Anything
  // else — a 404 page, an HTML body, a proxy error — is a different service.
  const declared = res.body && typeof res.body === 'object' ? res.body : undefined;
  const looksLikeBroker = declared !== undefined && 'device_flow_available' in declared;
  if (!looksLikeBroker) {
    return { kind: 'not-a-broker', detail: `HTTP ${res.status} with no NanoClaw registry response` };
  }

  const clientId = str(declared.client_id);
  if (!clientId) return { kind: 'no-idp' };
  return {
    kind: 'idp',
    config: {
      clientId,
      deviceEndpoint: str(declared.device_authorization_endpoint) ?? DEFAULT_DEVICE_ENDPOINT,
      tokenEndpoint: str(declared.token_endpoint) ?? DEFAULT_TOKEN_ENDPOINT,
    },
  };
}

function misconfiguredClient(): LoginError {
  return new LoginError(
    "The sign-in provider rejected this install's client id.",
    `Set ${ENV.clientId} to a WorkOS application that has CLI Auth enabled, or use an enrollment code instead.`,
  );
}

interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInS: number;
  intervalS: number;
}

async function requestDeviceAuthorization(cfg: IdpConfig): Promise<DeviceAuthorization> {
  let res: HttpResult;
  try {
    res = await http(cfg.deviceEndpoint, form({ client_id: cfg.clientId }), HTTP_TIMEOUT_MS);
  } catch (err) {
    throw new LoginError(`Couldn't reach the sign-in provider: ${message(err)}`, 'Check your network and re-run.');
  }

  if (res.status !== 200) {
    const code = str(res.body?.error);
    if (code === 'invalid_client' || code === 'unauthorized_client' || res.status === 401 || res.status === 404) {
      throw misconfiguredClient();
    }
    const detail = str(res.body?.error_description) ?? code ?? `HTTP ${res.status}`;
    throw new LoginError(`The sign-in provider wouldn't start a session: ${detail}`);
  }

  const deviceCode = str(res.body?.device_code);
  const userCode = str(res.body?.user_code);
  const verificationUri = str(res.body?.verification_uri);
  if (!deviceCode || !userCode || !verificationUri) {
    throw new LoginError('The sign-in provider returned an incomplete device authorization response.');
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: str(res.body?.verification_uri_complete),
    // Defaults are RFC 8628's own; a provider that omits them is unusual, not fatal.
    expiresInS: num(res.body?.expires_in) ?? 300,
    intervalS: Math.max(1, num(res.body?.interval) ?? 5),
  };
}

/**
 * Plain stdout on purpose. A status block here would be parsed and discarded by
 * every runner in the tree, and this is the one thing the user must actually see.
 */
function printDeviceCard(device: DeviceAuthorization, headless: boolean): void {
  const minutes = Math.max(1, Math.round(device.expiresInS / 60));
  const lines = ['', '   Finish authenticating in a browser:', ''];

  // One link rather than a bare URL and a pre-filled one side by side — the
  // pre-filled URL carries the code, so the second was only a way to pick the
  // wrong one. The code still prints: it is what you type when you open this on
  // a phone, it survives a terminal wrapping the URL, and it is the value the
  // provider's page shows back, which is how you tell you are approving this
  // sign-in and not another one.
  //
  // `verification_uri_complete` is OPTIONAL in RFC 8628 §3.2, so the two-part
  // form stays as a fallback — without it a provider that omits the field
  // leaves the user unable to sign in at all.
  if (device.verificationUriComplete) {
    lines.push(`     ${device.verificationUriComplete}`);
    lines.push('', `     Code:  ${device.userCode}   — the page should show this back to you`);
  } else {
    lines.push(`     Open:  ${device.verificationUri}`);
    lines.push(`     Code:  ${device.userCode}`);
  }
  lines.push(
    '',
    headless
      ? `   No browser on this machine — open that link on your phone or laptop.`
      : `   Your browser should open on its own; if it doesn't, use the link above.`,
    `   Waiting… this code expires in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    '',
  );
  console.log(lines.join('\n'));
}

/** Non-blocking best effort. Silent on failure — the URL is already on screen. */
function openInBrowser(url: string): void {
  let cmd: [string, string[]] | undefined;
  if (process.platform === 'darwin') cmd = ['open', [url]];
  else if (process.platform === 'linux') {
    if (commandExists('xdg-open')) cmd = ['xdg-open', [url]];
    else if (isWSL() && commandExists('wslview')) cmd = ['wslview', [url]];
    else if (isWSL()) cmd = ['cmd.exe', ['/c', 'start', '', url]];
  }
  if (!cmd) return;
  try {
    // Detached and unref'd: some xdg-open implementations don't return until the
    // browser exits, and this process has minutes of polling left to do.
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No opener available. The card already printed the URL.
  }
}

async function pollForIdpToken(cfg: IdpConfig, device: DeviceAuthorization): Promise<string> {
  let intervalMs = device.intervalS * 1000;
  const deadline = Date.now() + Math.min(device.expiresInS * 1000, MAX_DEVICE_WAIT_MS);
  let transportFailures = 0;

  for (;;) {
    if (Date.now() >= deadline) {
      throw new LoginError(
        'Timed out waiting for the sign-in to be approved.',
        'Re-run setup to get a fresh code.',
      );
    }
    await sleep(intervalMs);

    let res: HttpResult;
    try {
      res = await http(
        cfg.tokenEndpoint,
        form({ grant_type: DEVICE_GRANT_TYPE, device_code: device.deviceCode, client_id: cfg.clientId }),
        HTTP_TIMEOUT_MS,
      );
    } catch (err) {
      // A closed lid or a flaky hotspot must not cost the user their code, so a
      // transport failure is retried rather than surfaced.
      if (++transportFailures > MAX_POLL_TRANSPORT_FAILURES) {
        throw new LoginError(`Lost contact with the sign-in provider: ${message(err)}`);
      }
      continue;
    }
    transportFailures = 0;

    if (res.status === 200) {
      const token = str(res.body?.access_token);
      if (!token) throw new LoginError('The sign-in was approved but no access token came back.');
      return token;
    }

    switch (str(res.body?.error)) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        intervalMs += SLOW_DOWN_STEP_MS;
        continue;
      case 'expired_token':
        throw new LoginError(
          'That sign-in code expired before it was approved.',
          'Re-run setup to get a fresh code.',
        );
      case 'access_denied':
        throw new LoginError(
          'The sign-in was declined in the browser.',
          'Re-run setup if that was a mistake.',
        );
      case 'invalid_client':
      case 'unauthorized_client':
        throw misconfiguredClient();
      case 'unsupported_grant_type':
        throw new LoginError(
          "The sign-in provider doesn't have the device grant enabled for this client.",
          'Enable CLI Auth on the WorkOS application, or use an enrollment code.',
        );
      case 'invalid_grant':
        throw new LoginError(
          'The sign-in provider no longer recognises this device code.',
          'Re-run setup to start a fresh sign-in.',
        );
      default: {
        const detail = str(res.body?.error_description) ?? str(res.body?.error) ?? `HTTP ${res.status}`;
        throw new LoginError(`Sign-in failed: ${detail}`);
      }
    }
  }
}

async function deviceLogin(api: string, cfg: IdpConfig): Promise<EnrollResult> {
  const device = await requestDeviceAuthorization(cfg);
  const headless = isHeadless();
  printDeviceCard(device, headless);
  if (!headless) openInBrowser(device.verificationUriComplete ?? device.verificationUri);

  const idpToken = await pollForIdpToken(cfg, device);
  return enroll(api, { method: 'idp', provider: 'workos', access_token: idpToken, client: clientRecord() });
}

// ---------------------------------------------------------------------------
// Entry

function parseArgs(argv: string[]): Options {
  const opts: Options = { interactive: Boolean(process.stdin.isTTY), force: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--non-interactive':
        opts.interactive = false;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--api':
        opts.api = argv[++i];
        break;
      case '--code':
        opts.code = argv[++i];
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${argv[i]}`);
        printHelp();
        process.exit(1);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(
    [
      'Usage: setup/registry-login.sh [--non-interactive] [--force] [--api <url>] [--code <code>]',
      '',
      '  --non-interactive  Never prompt. Uses only the environment; exits 2 if nothing is set.',
      '  --force            Sign in again even if a valid credential is already stored.',
      `  --api <url>        Account service base URL (default ${DEFAULT_BROKER_URL}).`,
      '  --code <code>      Enrollment code, instead of the browser sign-in.',
      '',
      'Environment:',
      `  ${ENV.token}        Existing account token to adopt.`,
      `  ${ENV.enrollCode}  Enrollment code.`,
      `  ${ENV.api}          Account service base URL.`,
      `  ${ENV.clientId}      Device-flow client id.`,
      '',
      'Exit codes: 0 signed in · 2 skipped, caller may continue · 1 failed.',
    ].join('\n'),
  );
}

/**
 * Undefined means the user ended input (Ctrl-D) rather than answering — which
 * is a decline, not a crash. `rl.question` rejects on EOF, so without this a
 * piped or redirected stdin turns a skip into a failed sign-in.
 */
async function askLine(prompt: string): Promise<string | undefined> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } catch {
    return undefined;
  } finally {
    rl.close();
  }
}

/**
 * Wording and version travel together. The broker keeps its own copy of the
 * text for each version and stamps that onto the record, so what is stored is
 * what was displayed.
 *
 * Once this ships, editing the string below means adding a version on both
 * sides instead — re-labelling consent somebody already gave is the one thing
 * this pair exists to prevent. Until then there is nothing to protect, so the
 * wording stays on v1 and gets edited in place.
 *
 * Written as lines and joined for the record, so the text a person reads and
 * the text stored against their answer cannot drift apart.
 *
 * Echo is named because they are a second sender: somebody agreeing to hear
 * from NanoClaw has not thereby agreed to hear from whoever builds the image.
 */
const CONSENT_VERSION = 'cli-v1';
const CONSENT_LINES = [
  'NanoClaw and Echo, who build the agent image, may email me security notices',
  'and project updates. I can unsubscribe at any time.',
  'What we do with your address: https://nanoclaw.dev/privacy',
];
const CONSENT_TEXT = CONSENT_LINES.join(' ');

/**
 * Ask once per account.
 *
 * Three properties here are load-bearing: it never runs without somebody at the
 * terminal, it is asked once per account rather than once per machine, and
 * declining costs nothing — the image is already fetched by the time this runs
 * and nothing below can revoke it, which is what keeps the ask separable from
 * the thing being signed in for.
 *
 * Interim surface. The perks portal will own preferences, including the
 * withdrawal path a one-shot terminal prompt cannot offer; until it exists the
 * unsubscribe link in every email is that path.
 */
async function maybeAskEmailConsent(
  api: string,
  cred: AccountCredential,
  current: boolean | null,
): Promise<void> {
  if (current !== null) return;

  // clack rather than this file's own readline, so the question looks like the
  // rest of setup instead of a raw shell prompt appearing mid-flow. Safe from a
  // spawned child: stdio is inherited, so the rail lands in the same terminal
  // the wizard is drawing into, and standalone runs simply render without an
  // enclosing session.
  //
  // Line by line rather than one wrapped string: this ends with a URL, and a
  // terminal breaking it mid-link makes it unclickable and hard to copy.
  p.log.message(CONSENT_LINES.join('\n'));
  const answer = await p.confirm({
    message: 'Email me security and project updates?',
    initialValue: true,
    active: 'Yes',
    inactive: 'No',
  });
  // Ctrl-C, or stdin closing under a wrapper, is not an answer. Returning here
  // leaves the preference unset so the question can be asked again, where
  // falling through would store a decline and never ask anybody twice.
  if (p.isCancel(answer)) return;
  const optIn = answer === true;

  try {
    const res = await http(
      `${api}/v1/account/preferences`,
      json({ email_updates: optIn, consent_version: CONSENT_VERSION, source: 'cli' }, cred.token),
      HTTP_TIMEOUT_MS,
    );
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    // A lost decline changes nothing — the absence of a record is already a
    // no. A lost opt-in is the only case worth interrupting a good sign-in for.
    if (optIn) p.log.warn(`Couldn't record that (${message(err)}). Sign in again to retry.`);
    return;
  }
  if (optIn) p.log.success("You're on the list.");
}

function reportSuccess(cred: AccountCredential, method: LoginMethod): void {
  // The wizard reports the outcome itself, in its own voice, immediately after
  // we exit. Saying it here too gives the user the same fact twice in two
  // different formats.
  if (!SPAWNED_BY_WIZARD) {
    console.log(`\n   Authenticated as ${cred.email ?? cred.account_id}.`);
    if (cred.entitlements.length > 0) {
      console.log(`   Connected: ${cred.entitlements.join(', ')}`);
    }
    console.log('');
  }
  emitLoginStatus({
    STATUS: 'success',
    METHOD: method,
    ACCOUNT: cred.account_id,
    EMAIL: cred.email ?? '',
    ENTITLEMENTS: cred.entitlements.join(','),
  });
}

function reportSkipped(reason: string, detail?: string): void {
  if (detail) console.log(detail);
  process.exitCode = EXIT_SKIPPED;
  emitLoginStatus({ STATUS: 'skipped', REASON: reason });
}

export async function run(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  // Only a non-interactive caller can be parsing us. See `emitLoginStatus`.
  machineReadable = !opts.interactive;
  const api = resolveApiBase(opts.api);

  // Idempotence first: a resumed or re-run setup must not drag the user back
  // through a browser dance it already completed. A credential for a different
  // service is not that — tokens are meaningless across brokers, so retargeting
  // has to mean signing in again rather than probing the old one.
  const existing = readAccountCredential();
  if (existing && !opts.force && existing.api !== api) {
    console.log(`The stored sign-in is for ${existing.api}; signing in to ${api} instead.`);
  } else if (existing && !opts.force) {
    const probe = await probeSession(existing.api, existing.token);
    if (probe.state === 'ok') {
      const refreshed: AccountCredential = {
        ...existing,
        email: probe.email ?? existing.email,
        registry: probe.registry ?? existing.registry,
        entitlements: probe.entitlements,
      };
      persistCredential(refreshed);
      console.log(`Already authenticated as ${refreshed.email ?? refreshed.account_id}.`);
      emitLoginStatus({
        STATUS: 'skipped',
        REASON: 'already-signed-in',
        ACCOUNT: refreshed.account_id,
        EMAIL: refreshed.email ?? '',
        ENTITLEMENTS: refreshed.entitlements.join(','),
      });
      return;
    }
    if (probe.state === 'unreachable') {
      // Offline is not a reason to discard a working credential — the pull that
      // needs it may well be served from the local image cache anyway.
      console.log(`Couldn't reach the account service (${probe.reason}); keeping the stored sign-in.`);
      emitLoginStatus({
        STATUS: 'skipped',
        REASON: 'already-signed-in-unverified',
        ACCOUNT: existing.account_id,
      });
      return;
    }
    console.log('The stored NanoClaw sign-in is no longer valid — signing in again.');
  }

  const presetToken = str(process.env[ENV.token]);
  if (presetToken) {
    const probe = await probeSession(api, presetToken);
    if (probe.state !== 'ok') {
      const why = probe.state === 'unauthorized' ? 'it was rejected' : `the service was unreachable (${probe.reason})`;
      throw new LoginError(`The token in ${ENV.token} can't be used: ${why}.`);
    }
    const cred: AccountCredential = {
      version: 1,
      api,
      account_id: probe.account_id,
      email: probe.email,
      token: presetToken,
      registry: probe.registry,
      entitlements: probe.entitlements,
      created_at: new Date().toISOString(),
    };
    // Written to disk even though it came from the environment: docker spawns
    // the credential helper with an environment we don't control, so the file
    // is the only channel that reaches it.
    persistCredential(cred);
    reportSuccess(cred, 'token');
    return;
  }

  const presetCode = opts.code ?? str(process.env[ENV.enrollCode]);
  if (presetCode) {
    // No consent prompt on this path or the one above: both are the CI and
    // scripted route, where there is nobody to ask and a default of "yes"
    // would not be consent.
    const { credential: cred } = await enroll(api, { method: 'code', code: presetCode, client: clientRecord() });
    persistCredential(cred);
    reportSuccess(cred, 'code');
    return;
  }

  if (!opts.interactive) {
    reportSkipped(
      'non-interactive',
      `No sign-in credentials in the environment; set ${ENV.enrollCode} or ${ENV.token} to sign in without a terminal.`,
    );
    return;
  }

  const probe = await probeBroker(api);
  if (probe.kind === 'not-a-broker') {
    throw new LoginError(
      `No NanoClaw registry at ${api} (${probe.detail}).`,
      `Nothing at that address answers as a NanoClaw registry. If ${ENV.api} is set, check it points at one — unset, this reaches the hosted service. Either way \`./container/build.sh\` builds the image locally and needs no account.`,
    );
  }
  const idp = probe.kind === 'idp' ? probe.config : undefined;
  if (!idp) {
    // A real registry with no identity provider. Supported: the enrollment-code
    // path predates the IdP and outlives it.
    console.log('\n   Browser authentication is not configured for this registry.');
    const code = await askLine('   Enrollment code (or press Enter to skip): ');
    if (!code) {
      reportSkipped('declined');
      return;
    }
    const { credential: cred, emailUpdates } = await enroll(api, {
      method: 'code',
      code,
      client: clientRecord(),
    });
    persistCredential(cred);
    reportSuccess(cred, 'code');
    await maybeAskEmailConsent(api, cred, emailUpdates);
    return;
  }

  // Bare newline rather than a lead-in sentence: the prompt below says what
  // pressing Enter does, and the spacing keeps it off whatever printed last.
  console.log('');
  const typed = await askLine(
    '   Press Enter to open your browser and authenticate, or paste an enrollment code: ',
  );
  if (typed === undefined) {
    reportSkipped('declined');
    return;
  }
  const { credential: cred, emailUpdates } = typed
    ? await enroll(api, { method: 'code', code: typed, client: clientRecord() })
    : await deviceLogin(api, idp);
  persistCredential(cred);

  reportSuccess(cred, typed ? 'code' : 'device');
  await maybeAskEmailConsent(api, cred, emailUpdates);
}

async function main(): Promise<void> {
  try {
    await run(process.argv.slice(2));
  } catch (err) {
    const isLogin = err instanceof LoginError;
    console.error(`\n${isLogin ? err.message : `Sign-in failed: ${message(err)}`}`);
    if (isLogin && err.hint) console.error(err.hint);
    emitLoginStatus({
      STATUS: 'failed',
      ERROR: message(err),
      ...(isLogin && err.hint ? { HINT: err.hint } : {}),
    });
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
