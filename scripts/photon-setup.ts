#!/usr/bin/env pnpm exec tsx
/**
 * Photon iMessage setup wizard — frictionless first-time onboarding.
 *
 * Runs Photon's OAuth device-login flow, then provisions everything the
 * `photon` channel needs. One step stays manual by necessity: the delivery
 * plane only routes numbers whose user row carries `meta.opt_in`, and that flag
 * is set when the human sends one message from their phone to the line Photon
 * assigned to that user row. A freshly created row always starts without it.
 * The wizard prints the assigned line, waits for that message, and polls until
 * the opt-in lands, so it never reports success for a number that cannot
 * receive messages.
 *
 *   [1/5] Device login   — open a URL, approve, we store the bearer token
 *   [2/5] Project        — find or create the "NanoClaw" Photon project
 *   [3/5] Secret         — reuse the project's current secret (rotating only
 *                          when the API doesn't return one) and write
 *                          PHOTON_PROJECT_ID + PHOTON_PROJECT_SECRET to .env
 *   [4/5] User           — find or create your Spectrum user row, print the
 *                          line it was assigned, and wait until your first
 *                          message to that line flips the row to opted in
 *   [5/5] iMessage line  — surface the number you text to reach your agent
 *
 * Everything is idempotent — re-running reuses the stored token/project and
 * only fills gaps, so it's safe to run again to finish a partial setup.
 *
 * This talks ONLY to Photon's management HTTP APIs (dashboard + spectrum) — it
 * does NOT import `spectrum-ts`, so it works before /add-photon installs the
 * runtime SDK. The device token is cached in data/photon-auth.json (0600);
 * runtime creds live in .env like every other channel.
 *
 * Usage:
 *   pnpm exec tsx scripts/photon-setup.ts [setup] \
 *     [--phone +15551234567] [--project-name NanoClaw] \
 *     [--no-browser] [--non-interactive] \
 *     [--dashboard-host https://app.photon.codes] \
 *     [--spectrum-host https://spectrum.photon.codes]
 *
 *   pnpm exec tsx scripts/photon-setup.ts status   # show what's configured
 *
 * `--embedded` is for machine-driven runs (the setup wizard / the /add-imessage
 * skill's streaming step): it suppresses the standalone intro/outro while
 * preserving the provisioning progress and device prompt, and emits a terminal
 * `=== NANOCLAW SETUP: PHOTON ===` status block (STATUS/PHONE/LINE_NUMBER) on
 * success so a streaming exec can confirm the step and capture its fields.
 *
 * Reference: https://github.com/photon-hq/cli
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import * as p from '@clack/prompts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_DASHBOARD_HOST = 'https://app.photon.codes';
export const DEFAULT_SPECTRUM_HOST = 'https://spectrum.photon.codes';
// Photon allowlists registered device clients on the device-code endpoint; use
// the published CLI client id (matches photon-hq/cli's CLI_CLIENT_ID).
export const DEFAULT_CLIENT_ID = 'photon-cli';
export const DEFAULT_SCOPE = 'openid profile email';
export const DEFAULT_PROJECT_NAME = 'NanoClaw';
const DEFAULT_POLL_INTERVAL_S = 5;
const DEFAULT_POLL_TIMEOUT_S = 1800;
const DEFAULT_OPTIN_POLL_INTERVAL_S = 5;
const DEFAULT_OPTIN_TIMEOUT_S = 600;

const E164_RE = /^\+[1-9]\d{6,14}$/;

type FetchFn = typeof fetch;

// ---------------------------------------------------------------------------
// Low-level HTTP helpers
// ---------------------------------------------------------------------------

async function readJson(resp: Response): Promise<Record<string, unknown>> {
  try {
    const data = (await resp.json()) as unknown;
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function errorDetail(resp: Response): Promise<string> {
  const data = await readJson(resp);
  for (const key of ['error', 'message', 'detail']) {
    const val = data[key];
    if (val) return String(val);
  }
  return `HTTP ${resp.status}`;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/** HTTP Basic header from `projectId:projectSecret` (Spectrum user API auth). */
export function basicAuth(projectId: string, projectSecret: string): string {
  return 'Basic ' + Buffer.from(`${projectId}:${projectSecret}`).toString('base64');
}

// ---------------------------------------------------------------------------
// Phone helpers
// ---------------------------------------------------------------------------

export function normalizePhone(phone: string): string {
  return (phone || '').replace(/[^\d+]/g, '');
}

export function isE164(phone: string): boolean {
  return E164_RE.test(phone);
}

// ---------------------------------------------------------------------------
// Device-code login (RFC 8628)
// ---------------------------------------------------------------------------

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export async function requestDeviceCode(
  fetchFn: FetchFn,
  dashboardHost: string,
  clientId = DEFAULT_CLIENT_ID,
  scope: string | null = DEFAULT_SCOPE,
): Promise<DeviceCode> {
  const body: Record<string, unknown> = { client_id: clientId };
  if (scope) body.scope = scope;
  const resp = await fetchFn(`${dashboardHost}/api/auth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Photon device-code request failed: ${await errorDetail(resp)}`);
  const data = await readJson(resp);
  return {
    device_code: String(data.device_code),
    user_code: String(data.user_code),
    verification_uri: String(data.verification_uri),
    verification_uri_complete: data.verification_uri_complete ? String(data.verification_uri_complete) : undefined,
    expires_in: Number(data.expires_in) || DEFAULT_POLL_TIMEOUT_S,
    interval: Number(data.interval) || DEFAULT_POLL_INTERVAL_S,
  };
}

/** Extract token candidates across the shapes Photon has returned over time. */
export function deviceTokenCandidates(body: Record<string, unknown>, headers?: Headers): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    let token = value.trim();
    if (token.toLowerCase().startsWith('bearer ')) token = token.slice(7).trim();
    if (token && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  };
  add(body.access_token);
  add(body.accessToken);
  const session = body.session;
  if (session && typeof session === 'object') add((session as Record<string, unknown>).access_token);
  const data = body.data;
  if (data && typeof data === 'object') {
    add((data as Record<string, unknown>).access_token);
    add((data as Record<string, unknown>).accessToken);
  }
  if (headers) add(headers.get('set-auth-token') ?? undefined);
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface PollOptions {
  clientId?: string;
  intervalMs?: number;
  timeoutMs?: number;
  onPending?: () => void;
  sleepFn?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Poll the device-token endpoint until the user approves (RFC 8628 §3.4-3.5). */
export async function pollForToken(fetchFn: FetchFn, dashboardHost: string, code: DeviceCode, opts: PollOptions = {}): Promise<string> {
  const clientId = opts.clientId ?? DEFAULT_CLIENT_ID;
  const sleepFn = opts.sleepFn ?? sleep;
  const now = opts.now ?? Date.now;
  let intervalMs = opts.intervalMs ?? (code.interval || DEFAULT_POLL_INTERVAL_S) * 1000;
  const deadline = now() + (opts.timeoutMs ?? (code.expires_in || DEFAULT_POLL_TIMEOUT_S) * 1000);

  while (now() < deadline) {
    await sleepFn(intervalMs);
    let resp: Response;
    try {
      resp = await fetchFn(`${dashboardHost}/api/auth/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: code.device_code,
          client_id: clientId,
        }),
      });
    } catch {
      continue; // transient network hiccup — keep polling
    }
    if (resp.status === 200) {
      const body = await readJson(resp);
      const candidates = deviceTokenCandidates(body, resp.headers);
      if (candidates.length === 0) throw new Error('Photon returned 200 but no token in the device-token response');
      return candidates[0];
    }
    if (resp.status === 429) {
      intervalMs += 10_000;
      opts.onPending?.();
      continue;
    }
    if (resp.status === 400) {
      const body = await readJson(resp);
      const err = String(body.error || body.message || '');
      if (err === 'authorization_pending') {
        opts.onPending?.();
        continue;
      }
      if (err === 'slow_down') {
        intervalMs += 5_000;
        opts.onPending?.();
        continue;
      }
      if (err === 'expired_token' || err === 'access_denied') throw new Error(`Photon login failed: ${err}`);
      throw new Error(`Photon device-token error: ${err || 'unknown'}`);
    }
    // Unexpected status — keep polling until the deadline.
    opts.onPending?.();
  }
  throw new Error('Photon device login timed out');
}

/** Confirm a token works for the project APIs (not just session lookup). */
export async function validateToken(fetchFn: FetchFn, dashboardHost: string, token: string): Promise<void> {
  const session = await fetchFn(`${dashboardHost}/api/auth/get-session`, { headers: bearer(token) });
  if (session.status === 401 || session.status === 403) throw new Error('Photon rejected the device token (session lookup)');
  if (!session.ok) throw new Error(`Photon session lookup failed: ${await errorDetail(session)}`);
  const projects = await fetchFn(`${dashboardHost}/api/projects/`, { headers: bearer(token) });
  if (projects.status === 401 || projects.status === 403) throw new Error('Photon device token rejected by the project API');
  if (!projects.ok) throw new Error(`Photon project API check failed: ${await errorDetail(projects)}`);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function unwrapList(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === 'object') {
    for (const key of ['data', 'projects', 'users', 'lines', 'items']) {
      const inner = (data as Record<string, unknown>)[key];
      if (Array.isArray(inner)) return inner as Array<Record<string, unknown>>;
      if (inner && typeof inner === 'object') {
        for (const nested of ['projects', 'users', 'lines', 'items']) {
          const v = (inner as Record<string, unknown>)[nested];
          if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
        }
      }
    }
  }
  return [];
}

export async function listProjects(fetchFn: FetchFn, dashboardHost: string, token: string): Promise<Array<Record<string, unknown>>> {
  const resp = await fetchFn(`${dashboardHost}/api/projects`, { headers: bearer(token) });
  if (!resp.ok) throw new Error(`Photon list-projects failed: ${await errorDetail(resp)}`);
  return unwrapList(await resp.json().catch(() => []));
}

export function findProjectByName(projects: Array<Record<string, unknown>>, name: string): Record<string, unknown> | undefined {
  const target = (name || '').trim().toLowerCase();
  return projects.find((proj) => String(proj.name ?? '').trim().toLowerCase() === target);
}

/**
 * The project's current secret off an API project payload, if present. The
 * dashboard returns `projectSecret` on list/create responses; reusing it keeps
 * re-runs from rotating the secret and breaking every other consumer of the
 * project. Absent/blank → undefined (caller falls back to regenerating).
 */
export function projectSecretOf(project: Record<string, unknown> | undefined): string | undefined {
  const secret = project?.projectSecret;
  return typeof secret === 'string' && secret.trim() !== '' ? secret : undefined;
}

export async function createProject(
  fetchFn: FetchFn,
  dashboardHost: string,
  token: string,
  name: string,
  location = 'United States',
): Promise<Record<string, unknown>> {
  const resp = await fetchFn(`${dashboardHost}/api/projects`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ name, location, template: false, observability: false }),
  });
  if (!resp.ok) throw new Error(`Photon create-project failed: ${await errorDetail(resp)}`);
  const data = await readJson(resp);
  if (data.error) throw new Error(`Photon create-project failed: ${data.error}`);
  if (!data.id) throw new Error('Photon create-project did not return a project id');
  return data;
}

export async function regenerateProjectSecret(
  fetchFn: FetchFn,
  dashboardHost: string,
  token: string,
  projectId: string,
): Promise<string> {
  const resp = await fetchFn(`${dashboardHost}/api/projects/${projectId}/regenerate-secret`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({}),
  });
  if (!resp.ok) throw new Error(`Photon regenerate-secret failed: ${await errorDetail(resp)}`);
  const data = await readJson(resp);
  const secret = data.projectSecret;
  if (!secret) throw new Error('Photon regenerate-secret returned no projectSecret');
  return String(secret);
}

// ---------------------------------------------------------------------------
// Spectrum users
// ---------------------------------------------------------------------------

export async function listUsers(
  fetchFn: FetchFn,
  spectrumHost: string,
  projectId: string,
  projectSecret: string,
): Promise<Array<Record<string, unknown>>> {
  const resp = await fetchFn(`${spectrumHost}/projects/${projectId}/users/`, {
    headers: { Authorization: basicAuth(projectId, projectSecret) },
  });
  if (!resp.ok) throw new Error(`Photon list-users failed: ${await errorDetail(resp)}`);
  return unwrapList(await resp.json().catch(() => []));
}

export function findUserByPhone(users: Array<Record<string, unknown>>, phone: string): Record<string, unknown> | undefined {
  const target = normalizePhone(phone);
  return users.find((u) => normalizePhone(String(u.phoneNumber ?? '')) === target);
}

/**
 * Create a Spectrum user row for `phone`. The row comes back carrying the
 * `assignedPhoneNumber` the human must text, and an empty `meta` — the opt-in
 * flag is server-owned, so client-supplied meta is never sent.
 */
export async function createUser(
  fetchFn: FetchFn,
  spectrumHost: string,
  projectId: string,
  projectSecret: string,
  phone: string,
  firstName?: string,
): Promise<Record<string, unknown>> {
  if (!isE164(phone)) throw new Error(`phone must be E.164 (e.g. +15551234567); got ${phone}`);
  const body: Record<string, unknown> = { type: 'shared', phoneNumber: phone };
  if (firstName) body.firstName = firstName;
  const resp = await fetchFn(`${spectrumHost}/projects/${projectId}/users/`, {
    method: 'POST',
    headers: { Authorization: basicAuth(projectId, projectSecret), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Photon create-user failed: ${await errorDetail(resp)}`);
  const data = await readJson(resp);
  // The service reports failures as HTTP 200 with an {"error": …} body.
  if (data.error) throw new Error(`Photon create-user failed: ${data.error}`);
  return (data.user as Record<string, unknown>) || (data.data as Record<string, unknown>) || data;
}

/**
 * The routing row for `phone`, created if it does not exist yet. A re-run must
 * reuse the row it already made — a second create would hand out a fresh row
 * and drop an opt-in that already landed.
 */
export async function ensureUser(
  fetchFn: FetchFn,
  spectrumHost: string,
  projectId: string,
  projectSecret: string,
  phone: string,
  firstName?: string,
): Promise<{ user: Record<string, unknown>; created: boolean }> {
  const existing = findRoutableUser(await listUsers(fetchFn, spectrumHost, projectId, projectSecret), phone);
  if (existing) return { user: existing, created: false };
  return { user: await createUser(fetchFn, spectrumHost, projectId, projectSecret, phone, firstName), created: true };
}

/**
 * True when the delivery plane will route messages for this user: the row
 * carries `meta.opt_in`, which the service sets once the human has sent a
 * message from `phoneNumber` to the row's `assignedPhoneNumber`. A row without
 * it looks registered everywhere but never sends or receives.
 */
export function userOptedIn(user: Record<string, unknown> | undefined): boolean {
  const meta = user?.meta;
  return !!meta && typeof meta === 'object' && (meta as Record<string, unknown>).opt_in === true;
}

/**
 * The row that decides routing for `phone`. When duplicates exist for the same
 * number, an opted-in row wins over whichever happens to list first — opt-in is
 * scoped to one user-number/assigned-line pair, so only that row routes.
 */
export function findRoutableUser(users: Array<Record<string, unknown>>, phone: string): Record<string, unknown> | undefined {
  const target = normalizePhone(phone);
  const matches = users.filter((u) => normalizePhone(String(u.phoneNumber ?? '')) === target);
  return matches.find(userOptedIn) ?? matches[0];
}

export interface OptInWaitOpts {
  sleepFn?: (ms: number) => Promise<void>;
  intervalS?: number;
  timeoutS?: number;
  /** Progress hook, called once per poll that did not find an opted-in row (1-based). */
  onWaiting?: (attempt: number) => void;
  /** The line the human has to text, named in the timeout message when known. */
  assignedLine?: string | null;
}

/**
 * The manual step, as printed to the operator: the opt-in is performed by one
 * message from `phone` to `assignedLine`, and nothing else can stand in for it.
 */
export function optInInstructions(phone: string, assignedLine: string | null): string[] {
  if (!assignedLine) {
    return [
      'Photon has not assigned an iMessage line to your number yet.',
      '',
      `Once it does, send one message from ${phone} to that line to opt in.`,
      '',
      'Setup waits here and continues once the opt-in lands.',
    ];
  }
  return [
    'Your number only enters iMessage routing after it has messaged',
    'the line Photon assigned to it, so this one step is manual:',
    '',
    `  1. Open Messages on ${phone}.`,
    `  2. Text ${assignedLine} — one message of any content is enough.`,
    '',
    'Setup waits here and continues once the opt-in lands.',
  ];
}

/**
 * Poll until `phone`'s user row exists AND is opted in, then return the row.
 * A row starts un-opted-in whatever created it; the flag lands only after the
 * human sends a message from `phone` to the row's assigned line. Throws after
 * `timeoutS` (attempt-count based, so tests with an instant sleepFn stay
 * deterministic).
 */
export async function waitForOptedInUser(
  fetchFn: FetchFn,
  spectrumHost: string,
  projectId: string,
  projectSecret: string,
  phone: string,
  opts: OptInWaitOpts = {},
): Promise<Record<string, unknown>> {
  const intervalS = Math.max(1, opts.intervalS ?? DEFAULT_OPTIN_POLL_INTERVAL_S);
  const timeoutS = opts.timeoutS ?? DEFAULT_OPTIN_TIMEOUT_S;
  const sleepFn = opts.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = Math.max(1, Math.ceil(timeoutS / intervalS));
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const user = findRoutableUser(await listUsers(fetchFn, spectrumHost, projectId, projectSecret), phone);
      lastError = undefined;
      if (userOptedIn(user)) return user as Record<string, unknown>;
    } catch (err) {
      // A transient list failure must not abort a wait whose whole point is to
      // ride out the operator's manual step — count it as a missed poll and
      // keep going, like the device-token poll does.
      lastError = err;
    }
    opts.onWaiting?.(attempt);
    if (attempt < maxAttempts) await sleepFn(intervalS * 1000);
  }
  const lastErrorNote = lastError ? ` Last API error: ${lastError instanceof Error ? lastError.message : String(lastError)}.` : '';
  const target = opts.assignedLine ? `to ${opts.assignedLine}` : 'to the line Photon assigned to it';
  throw new Error(
    `${phone} was not opted in after ${timeoutS}s.${lastErrorNote} Send one message from ${phone} ${target}, then re-run setup — it resumes where it left off.`,
  );
}

/** The iMessage number a user texts to reach the agent ("TEXTS ON" column). */
export function userAssignedLine(user: Record<string, unknown> | undefined): string | null {
  if (!user) return null;
  const val = user.assignedPhoneNumber;
  return val ? String(val) : null;
}

export async function listLines(
  fetchFn: FetchFn,
  dashboardHost: string,
  token: string,
  projectId: string,
): Promise<Array<Record<string, unknown>>> {
  const resp = await fetchFn(`${dashboardHost}/api/projects/${projectId}/lines`, { headers: bearer(token) });
  if (!resp.ok) throw new Error(`Photon list-lines failed: ${await errorDetail(resp)}`);
  return unwrapList(await resp.json().catch(() => []));
}

export async function getImessageLine(
  fetchFn: FetchFn,
  dashboardHost: string,
  token: string,
  projectId: string,
  createIfMissing = true,
): Promise<Record<string, unknown> | null> {
  const lines = await listLines(fetchFn, dashboardHost, token, projectId);
  const found = lines.find((l) => String(l.platform ?? '').toLowerCase() === 'imessage');
  if (found) return found;
  if (!createIfMissing) return null;
  const resp = await fetchFn(`${dashboardHost}/api/projects/${projectId}/lines`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ platform: 'imessage' }),
  });
  if (!resp.ok) return null;
  const data = await readJson(resp);
  // Line add/remove is plan-gated and the API reports that as HTTP 200 with an
  // {"error": …} body — never treat that as a line.
  if (data.error) return null;
  return (data.line as Record<string, unknown>) || data;
}

// ---------------------------------------------------------------------------
// .env + token storage
// ---------------------------------------------------------------------------

/**
 * Upsert `key=value` pairs into a .env file's contents (pure). Existing keys
 * are replaced in place; new keys are appended. Comments and unrelated lines
 * are preserved.
 */
export function upsertEnv(existing: string, kv: Record<string, string>): string {
  const remaining = new Map(Object.entries(kv));
  const lines = existing.length ? existing.split('\n') : [];
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (remaining.has(key)) {
      const value = remaining.get(key)!;
      remaining.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  if (remaining.size > 0) {
    // Drop a single trailing blank line (from the file's final newline) so
    // appended keys sit flush with existing content instead of after a gap.
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    for (const [key, value] of remaining) out.push(`${key}=${value}`);
  }
  let result = out.join('\n');
  if (result.length && !result.endsWith('\n')) result += '\n';
  return result;
}

function writeEnv(envPath: string, kv: Record<string, string>): void {
  let existing = '';
  try {
    existing = fs.readFileSync(envPath, 'utf-8');
  } catch {
    existing = '';
  }
  fs.writeFileSync(envPath, upsertEnv(existing, kv), { mode: 0o600 });
}

interface StoredAuth {
  access_token?: string;
  project_id?: string;
  name?: string;
  phone_number?: string;
  assigned_phone_number?: string;
}

function authPath(): string {
  return path.join(process.cwd(), 'data', 'photon-auth.json');
}

function loadAuth(): StoredAuth {
  try {
    return JSON.parse(fs.readFileSync(authPath(), 'utf-8')) as StoredAuth;
  } catch {
    return {};
  }
}

function saveAuth(patch: StoredAuth): void {
  const merged = { ...loadAuth(), ...patch };
  const dir = path.dirname(authPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(authPath(), JSON.stringify(merged, null, 2), { mode: 0o600 });
}

function envValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  try {
    const content = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      if (trimmed.slice(0, eq).trim() === key) return trimmed.slice(eq + 1).trim();
    }
  } catch {
    /* no .env */
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

interface Args {
  command: 'setup' | 'status';
  phone?: string;
  projectName: string;
  noBrowser: boolean;
  interactive: boolean;
  embedded: boolean;
  dashboardHost: string;
  spectrumHost: string;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'setup',
    projectName: DEFAULT_PROJECT_NAME,
    noBrowser: false,
    interactive: true,
    embedded: false,
    dashboardHost: process.env.PHOTON_DASHBOARD_HOST || DEFAULT_DASHBOARD_HOST,
    spectrumHost: process.env.PHOTON_SPECTRUM_HOST || DEFAULT_SPECTRUM_HOST,
  };
  const rest = [...argv];
  if (rest[0] === 'setup' || rest[0] === 'status') {
    args.command = rest.shift() as 'setup' | 'status';
  }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const val = rest[i + 1];
    switch (flag) {
      case '--phone':
        args.phone = normalizePhone(val ?? '');
        i++;
        break;
      case '--project-name':
        args.projectName = val ?? DEFAULT_PROJECT_NAME;
        i++;
        break;
      case '--dashboard-host':
        args.dashboardHost = (val ?? '').replace(/\/+$/, '') || args.dashboardHost;
        i++;
        break;
      case '--spectrum-host':
        args.spectrumHost = (val ?? '').replace(/\/+$/, '') || args.spectrumHost;
        i++;
        break;
      case '--no-browser':
        args.noBrowser = true;
        break;
      case '--non-interactive':
        args.interactive = false;
        break;
      case '--embedded':
        args.embedded = true;
        break;
      case '--help':
      case '-h':
        console.log('See scripts/photon-setup.ts header for usage.');
        process.exit(0);
    }
  }
  return args;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* best-effort */
  }
}

async function runStatus(args: Args, fetchFn: FetchFn = fetch): Promise<number> {
  const auth = loadAuth();
  const projectId = envValue('PHOTON_PROJECT_ID') || auth.project_id;
  const secret = envValue('PHOTON_PROJECT_SECRET');
  const credentialsReady = Boolean(projectId && secret);
  // setup writes phone_number only after the user row carries meta.opt_in — but
  // state written by older setups can hold a phone_number whose row was never
  // opted in (and so never routed). When credentials allow it, ask the API
  // instead of trusting the local marker.
  let routing: 'ready' | 'not-opted-in' | 'unverified' | 'unconfigured' = 'unconfigured';
  let routingError = '';
  let liveAssigned: string | null = null;
  if (credentialsReady && auth.phone_number) {
    try {
      const user = findRoutableUser(
        await listUsers(fetchFn, args.spectrumHost, String(projectId), String(secret)),
        auth.phone_number,
      );
      liveAssigned = userAssignedLine(user);
      routing = userOptedIn(user) ? 'ready' : 'not-opted-in';
    } catch (err) {
      routing = 'unverified';
      routingError = err instanceof Error ? err.message : String(err);
    }
  }
  const optInTarget = liveAssigned || auth.assigned_phone_number;
  const routingLine = {
    ready: '✓ opted in (verified live)',
    'not-opted-in': `✗ not opted in — text ${optInTarget || 'your assigned line'} once from ${auth.phone_number}`,
    unverified: `? could not verify (${routingError})`,
    unconfigured: '✗ not configured',
  }[routing];
  p.intro('Photon iMessage status');
  p.log.message(
    [
      `  device token     : ${auth.access_token ? '✓ stored' : '✗ missing (run setup)'}`,
      `  project id       : ${projectId || '✗ missing'}`,
      `  project secret   : ${secret ? '✓ stored' : '✗ missing'}`,
      `  your number      : ${auth.phone_number || '✗ missing (run setup --phone ...)'}`,
      `  routing          : ${routingLine}`,
      `  agent's number   : ${auth.assigned_phone_number || '✗ unknown (run setup)'}`,
      `  dashboard host   : ${args.dashboardHost}`,
    ].join('\n'),
  );
  if (routing === 'ready') {
    p.outro('Photon routing is configured. Start the service and run /init-first-agent.');
    return 0;
  }
  if (routing === 'not-opted-in') {
    p.outro(
      `Your number is registered but not opted in. Text ${optInTarget || 'the assigned line'} once from ${auth.phone_number}, then re-run setup.`,
    );
    return 1;
  }
  if (routing === 'unverified') {
    p.outro('Could not verify routing. Check connectivity and that the stored project secret is still valid, then try again.');
    return 1;
  }
  if (credentialsReady) {
    p.outro('Photon credentials are saved, but phone routing is not ready. Re-run setup with --phone to register and opt in your number.');
    return 1;
  }
  p.outro('Run setup to finish onboarding.');
  return 1;
}

interface SetupDeps {
  /** Injectable poll sleep (tests use a no-op to run instantly). */
  sleepFn?: (ms: number) => Promise<void>;
}

async function runSetup(args: Args, fetchFn: FetchFn = fetch, deps: SetupDeps = {}): Promise<number> {
  if (!args.embedded) p.intro('Photon iMessage setup');

  // [1/5] Device login (reuse a stored, still-valid token when present).
  let token = loadAuth().access_token;
  if (token) {
    try {
      await validateToken(fetchFn, args.dashboardHost, token);
      p.log.step('[1/5] Reusing stored Photon login');
    } catch {
      token = undefined;
    }
  }
  if (!token) {
    p.log.step('[1/5] Photon device login');
    const code = await requestDeviceCode(fetchFn, args.dashboardHost);
    const target = code.verification_uri_complete || code.verification_uri;
    p.note(`Open:  ${target}\nCode:  ${code.user_code}`, 'Approve this device');
    if (!args.noBrowser) openBrowser(target);
    const spin = p.spinner();
    spin.start('Waiting for you to approve in the browser…');
    try {
      token = await pollForToken(fetchFn, args.dashboardHost, code, { sleepFn: deps.sleepFn });
      await validateToken(fetchFn, args.dashboardHost, token);
    } catch (err) {
      spin.stop('Login failed');
      p.cancel(err instanceof Error ? err.message : String(err));
      return 1;
    }
    spin.stop('Logged in');
    saveAuth({ access_token: token });
  }

  // [2/5] Find or create the project.
  p.log.step(`[2/5] Photon project "${args.projectName}"`);
  let projectId: string;
  let currentSecret: string | undefined;
  try {
    const existing = findProjectByName(await listProjects(fetchFn, args.dashboardHost, token), args.projectName);
    if (existing?.id) {
      projectId = String(existing.id);
      currentSecret = projectSecretOf(existing);
      p.log.info('Found existing project');
    } else {
      const created = await createProject(fetchFn, args.dashboardHost, token, args.projectName);
      projectId = String(created.id);
      currentSecret = projectSecretOf(created);
      p.log.info('Created project');
    }
  } catch (err) {
    p.cancel(`Project setup failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // [3/5] Persist runtime creds. Reuse the project's current secret — rotating
  // on every run would invalidate the previous secret and break every other
  // install using this project. Regenerate only when the API returned none.
  p.log.step('[3/5] Provisioning Spectrum credentials');
  let secret: string;
  if (currentSecret) {
    secret = currentSecret;
    p.log.info('Reusing existing project secret');
  } else {
    try {
      secret = await regenerateProjectSecret(fetchFn, args.dashboardHost, token, projectId);
    } catch (err) {
      p.cancel(`Secret provisioning failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  writeEnv(path.join(process.cwd(), '.env'), { PHOTON_PROJECT_ID: projectId, PHOTON_PROJECT_SECRET: secret });
  saveAuth({ project_id: projectId, name: args.projectName });
  p.log.info(`Saved PHOTON_PROJECT_ID + PHOTON_PROJECT_SECRET to .env (project id ${projectId})`);

  // [4/5] Register the operator's phone as a Spectrum user.
  let phone = args.phone;
  if (!phone && args.interactive && process.stdin.isTTY) {
    const answer = await p.text({
      message: 'Your iMessage phone number (E.164, e.g. +15551234567)',
      validate: (v) => (isE164(normalizePhone(v)) ? undefined : 'Enter a valid E.164 number, e.g. +15551234567'),
    });
    if (p.isCancel(answer)) {
      p.cancel('Setup cancelled');
      return 1;
    }
    phone = normalizePhone(answer);
  }

  let assigned: string | null = null;
  if (!phone) {
    p.log.warn('[4/5] Skipped phone registration (no --phone given). Re-run with --phone later.');
  } else if (!isE164(phone)) {
    p.cancel(`Invalid phone number: ${phone}`);
    return 1;
  } else {
    p.log.step('[4/5] Registering your phone');
    try {
      const { user, created } = await ensureUser(fetchFn, args.spectrumHost, projectId, secret, phone);
      const line = userAssignedLine(user);
      p.log.info(created ? `Created your Photon user (assigned line ${line ?? 'pending'})` : 'Found your existing Photon user');
      if (userOptedIn(user)) {
        p.log.info('Phone already opted in');
        assigned = line;
      } else {
        p.note(optInInstructions(phone, line).join('\n'), 'One step needed on your phone');
        const opted = await waitForOptedInUser(fetchFn, args.spectrumHost, projectId, secret, phone, {
          sleepFn: deps.sleepFn,
          assignedLine: line,
          onWaiting: (attempt) => {
            if (attempt % 6 === 0) p.log.message(`Still waiting for the opt-in for ${phone}…`);
          },
        });
        p.log.info('Phone registered and opted in');
        assigned = userAssignedLine(opted) ?? line;
      }
    } catch (err) {
      p.cancel(`User registration failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  // [5/5] Surface the number the operator texts to reach the agent. With a
  // phone this is the user row's assigned line (already learned in [4/5]); the
  // project-line lookup only covers the no-phone run, which has no row to read.
  p.log.step("[5/5] Your agent's iMessage number");
  if (!assigned) {
    try {
      const line = await getImessageLine(fetchFn, args.dashboardHost, token, projectId);
      if (line?.phoneNumber) assigned = String(line.phoneNumber);
    } catch {
      /* non-fatal */
    }
  }
  // Only write the keys we actually learned this run — a merge with explicit
  // undefined would erase the stored values on a no-phone re-run (and with
  // them the routing-ready signal `status` reads).
  saveAuth({
    ...(phone ? { phone_number: phone } : {}),
    ...(assigned ? { assigned_phone_number: assigned } : {}),
  });

  if (assigned) {
    p.note(`📱  ${assigned}\n\nThis is the number you text to talk to your agent.`, "Agent's iMessage number");
  } else {
    p.log.warn('No iMessage line assigned yet — re-run setup with --phone to register your number and get one.');
  }

  if (!args.embedded) {
    p.outro(
      [
        'Photon setup complete.',
        '',
        'Next:',
        '  1. Install the runtime SDK (if not already):  pnpm install spectrum-ts@11.0.0',
        '  2. (Re)start the NanoClaw service so the channel connects.',
        phone
          ? `  3. Wire your DM to an agent:  npx tsx scripts/init-first-agent.ts --channel imessage --user-id imessage:${phone} --platform-id ${phone} --display-name "You"`
          : '  3. Run /init-first-agent to wire your DM to an agent.',
      ].join('\n'),
    );
  } else {
    // Machine-readable terminal status for embedded (skill/wizard) runs — the
    // streaming exec parses this block and treats the step as passed only when
    // it sees STATUS: success (a clean exit code alone is not enough).
    const fields = [
      '=== NANOCLAW SETUP: PHOTON ===',
      'STATUS: success',
      ...(phone ? [`PHONE: ${phone}`] : []),
      ...(assigned ? [`LINE_NUMBER: ${assigned}`] : []),
      '=== END ===',
    ];
    process.stdout.write(fields.join('\n') + '\n');
  }
  return 0;
}

export async function main(argv: string[], fetchFn: FetchFn = fetch, deps: SetupDeps = {}): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === 'status') return runStatus(args, fetchFn);
  return runSetup(args, fetchFn, deps);
}

// Only run when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1] && /photon-setup\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
