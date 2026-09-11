/**
 * Telegram pairing — proves the operator owns the chat they're registering.
 *
 * BotFather hands out tokens with no user binding, so anyone who guesses the
 * bot's username can DM it. Pairing closes that gap: setup creates a one-time
 * 6-digit code and the operator echoes it back from the chat they want to
 * register (see extractCode for the exact match rule). The inbound interceptor
 * in telegram.ts matches the code, records the chat, upserts the paired user,
 * and (if no owner exists yet) promotes them to owner — all before the
 * message ever reaches the router.
 *
 * Storage is a JSON file at data/telegram-pairings.json — single-process,
 * read-modify-write under an in-process mutex.
 *
 * Records are instance-bound: a code is created for one adapter instance
 * ('telegram' for the default bot, 'telegram-<name>' for a named one) and only
 * that bot's interceptor can consume it; a wrong guess sent to one bot
 * invalidates only that bot's pending codes. Records written before instances
 * existed carry no `instance` field and read as the default bot.
 */
import { randomInt } from 'node:crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';

export type PairingIntent = 'main' | { kind: 'wire-to'; folder: string } | { kind: 'new-agent'; folder: string };
export type PairingStatus = 'pending' | 'consumed' | 'invalidated' | 'unknown';

export interface ConsumedDetails {
  platformId: string;
  isGroup: boolean;
  name: string | null;
  adminUserId: string | null;
  consumedAt: string;
}

export interface PairingAttempt {
  candidate: string;
  platformId: string;
  at: string;
  matched: boolean;
}

export interface PairingRecord {
  code: string;
  intent: PairingIntent;
  /** Adapter instance the code pairs on. Absent on legacy records: the default bot. */
  instance?: string;
  createdAt: string;
  status: Exclude<PairingStatus, 'unknown'>;
  consumed?: ConsumedDetails;
  /** Recent pairing attempts observed while this record was pending. Capped. */
  attempts?: PairingAttempt[];
}

const MAX_ATTEMPTS_PER_RECORD = 10;
/** Registry key of the default bot; also what a record with no `instance` means. */
const DEFAULT_INSTANCE = 'telegram';
const onInstance = (r: PairingRecord, instance: string) => (r.instance ?? DEFAULT_INSTANCE) === instance;

function intentEquals(a: PairingIntent, b: PairingIntent): boolean {
  if (a === 'main' || b === 'main') return a === b;
  return a.kind === b.kind && a.folder === b.folder;
}

interface Store {
  pairings: PairingRecord[];
}

/** Pairing codes do not expire — they are consumed on match or invalidated by wrong guesses. */
const FILE_NAME = 'telegram-pairings.json';

let storePathOverride: string | null = null;
export function _setStorePathForTest(p: string | null): void {
  storePathOverride = p;
}

function storePath(): string {
  return storePathOverride ?? path.join(DATA_DIR, FILE_NAME);
}

let mutex: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const next = mutex.then(() => fn());
  mutex = next.catch(() => {});
  return next;
}

function readStore(): Store {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as Store;
    if (!Array.isArray(parsed.pairings)) return { pairings: [] };
    return parsed;
  } catch {
    return { pairings: [] };
  }
}

function writeStore(store: Store): void {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, p);
}

/** Clean up old consumed/invalidated records (keep last 50). */
function sweep(store: Store): boolean {
  if (store.pairings.length <= 50) return false;
  store.pairings = store.pairings.slice(-50);
  return true;
}

function generateCode(active: Set<string>): string {
  // 6-digit numeric, zero-padded, from a CSPRNG. The code is the sole
  // authenticator binding a Telegram account to an agent group (and can
  // promote to owner on a fresh install), and codes do not expire — so the
  // stream must not be predictable from previously issued codes.
  // Math.random() (xorshift128+) is state-recoverable from observed outputs.
  // randomInt is rejection-sampled, so the draw is uniform.
  for (let i = 0; i < 50; i++) {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    if (!active.has(code)) return code;
  }
  throw new Error('Could not allocate a free pairing code (too many active).');
}

export async function createPairing(
  intent: PairingIntent,
  instance: string = DEFAULT_INSTANCE,
): Promise<PairingRecord> {
  return withLock(() => {
    const store = readStore();
    sweep(store);
    // Replace-by-default: a new pairing for an intent supersedes any existing
    // pending pairing for the same intent on the same instance. Old
    // waitForPairing calls observe `invalidated` and exit on their own.
    for (const r of store.pairings) {
      if (r.status === 'pending' && intentEquals(r.intent, intent) && onInstance(r, instance)) {
        r.status = 'invalidated';
        log.info('Pairing superseded by new request', { code: r.code, intent, instance });
      }
    }
    const active = new Set(store.pairings.filter((r) => r.status === 'pending').map((r) => r.code));
    const record: PairingRecord = {
      code: generateCode(active),
      intent,
      instance,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    store.pairings.push(record);
    writeStore(store);
    log.info('Pairing created', { code: record.code, intent, instance });
    return record;
  });
}

export interface ConsumeInput {
  text: string;
  botUsername: string;
  platformId: string;
  isGroup: boolean;
  name?: string | null;
  adminUserId?: string | null;
  /** Adapter instance that observed the message. Omitted: the default bot. */
  instance?: string;
}

/** Strip leading @botname and return the trimmed remainder, or null if not addressed. */
export function extractAddressedText(text: string, botUsername: string): string | null {
  const trimmed = text.trim();
  const re = new RegExp(`^@${botUsername.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i');
  const m = trimmed.match(re);
  if (!m) return null;
  return trimmed.slice(m[0].length).trim();
}

/**
 * Extract a pairing code from an inbound message. The message must contain
 * nothing but the 6 digits (optionally prefixed by `@botname `) — loose
 * matches like "my pin is 123456" are rejected to avoid false positives from
 * chatter. Whitespace between the digits is allowed: the setup card displays
 * the code spaced ("1   2   3   4   5   6"), and operators paste it verbatim.
 */
export function extractCode(text: string, botUsername: string): string | null {
  const addressed = extractAddressedText(text, botUsername);
  const candidate = (addressed !== null ? addressed : text).replace(/\s+/g, '');
  const m = candidate.match(/^(\d{6})$/);
  return m ? m[1] : null;
}

/**
 * Try to match an inbound message against a pending pairing. On match,
 * marks the pairing consumed atomically and returns the record. Returns
 * null on no match or expiry (silent drop).
 */
export async function tryConsume(input: ConsumeInput): Promise<PairingRecord | null> {
  const code = extractCode(input.text, input.botUsername);
  if (!code) return null;
  const instance = input.instance ?? DEFAULT_INSTANCE;
  return withLock(() => {
    const store = readStore();
    const now = Date.now();
    sweep(store);
    const record = store.pairings.find((r) => r.code === code && r.status === 'pending' && onInstance(r, instance));
    if (!record) {
      // Miss: record the attempt on every record pending on THIS instance so
      // each waitForPairing caller can surface it as user feedback. Sibling
      // bots' pendings are untouched: a wrong guess (or another bot's code)
      // sent to one bot must not cancel a pairing in flight on another.
      const attempt: PairingAttempt = {
        candidate: code,
        platformId: input.platformId,
        at: new Date(now).toISOString(),
        matched: false,
      };
      let recorded = false;
      for (const r of store.pairings) {
        if (r.status !== 'pending' || !onInstance(r, instance)) continue;
        r.attempts = [...(r.attempts ?? []), attempt].slice(-MAX_ATTEMPTS_PER_RECORD);
        // One attempt per code. A wrong guess invalidates the pairing
        // immediately — pair-telegram observes the `invalidated` signal and
        // auto-issues a fresh code (up to a retry cap).
        r.status = 'invalidated';
        recorded = true;
      }
      writeStore(store);
      if (recorded) {
        log.info('Pairing invalidated by wrong attempt', { candidate: code, platformId: input.platformId, instance });
      }
      return null;
    }
    record.status = 'consumed';
    record.consumed = {
      platformId: input.platformId,
      isGroup: input.isGroup,
      name: input.name ?? null,
      adminUserId: input.adminUserId ?? null,
      consumedAt: new Date(now).toISOString(),
    };
    record.attempts = [
      ...(record.attempts ?? []),
      { candidate: code, platformId: input.platformId, at: new Date(now).toISOString(), matched: true },
    ].slice(-MAX_ATTEMPTS_PER_RECORD);
    writeStore(store);
    log.info('Pairing consumed', { code, platformId: input.platformId, intent: record.intent, instance });
    return record;
  });
}

export function getStatus(code: string): PairingStatus {
  const store = readStore();
  sweep(store);
  const r = store.pairings.find((p) => p.code === code);
  if (!r) return 'unknown';
  return r.status;
}

export function getPairing(code: string): PairingRecord | null {
  const store = readStore();
  sweep(store);
  return store.pairings.find((p) => p.code === code) ?? null;
}

export interface WaitForPairingOptions {
  /** Polling interval as a fallback when fs.watch misses an event. */
  pollMs?: number;
  /** Fires once per new attempt recorded against this pairing (misses only). */
  onAttempt?: (attempt: PairingAttempt) => void;
}

/**
 * Resolve when the pairing is consumed; reject when it is invalidated
 * (wrong code guess). Waits indefinitely — codes do not expire.
 * Uses fs.watch as the primary signal with a slow poll fallback.
 */
export async function waitForPairing(code: string, opts: WaitForPairingOptions = {}): Promise<PairingRecord> {
  const pollMs = opts.pollMs ?? 1000;
  const initial = getPairing(code);
  if (!initial) throw new Error(`Unknown pairing code: ${code}`);

  return new Promise<PairingRecord>((resolve, reject) => {
    let watcher: fs.FSWatcher | null = null;
    let interval: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = () => {
      settled = true;
      if (watcher)
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
      if (interval) clearInterval(interval);
    };

    let seenAttempts = 0;
    const check = () => {
      if (settled) return;
      const r = getPairing(code);
      if (!r) {
        cleanup();
        reject(new Error(`Pairing ${code} disappeared`));
        return;
      }
      // Surface any new miss attempts since the last tick. Only fire for
      // misses — matches are signaled by `status === 'consumed'` below.
      if (opts.onAttempt && r.attempts) {
        for (let i = seenAttempts; i < r.attempts.length; i++) {
          const a = r.attempts[i];
          if (!a.matched) {
            try {
              opts.onAttempt(a);
            } catch {
              /* ignore */
            }
          }
        }
        seenAttempts = r.attempts.length;
      }
      if (r.status === 'consumed') {
        cleanup();
        resolve(r);
        return;
      }
      if (r.status === 'invalidated') {
        cleanup();
        const lastMiss = r.attempts
          ?.slice()
          .reverse()
          .find((a) => !a.matched);
        reject(new Error(`Pairing ${code} invalidated by wrong code${lastMiss ? ` (${lastMiss.candidate})` : ''}`));
        return;
      }
    };

    try {
      const dir = path.dirname(storePath());
      fs.mkdirSync(dir, { recursive: true });
      watcher = fs.watch(dir, (_event, fname) => {
        if (!fname || fname.toString().startsWith(path.basename(storePath()))) check();
      });
    } catch {
      // fs.watch unsupported — poll-only is fine
    }
    interval = setInterval(check, pollMs);
    check();
  });
}

/** Test helper — wipe the store. */
export function _resetForTest(): void {
  try {
    fs.unlinkSync(storePath());
  } catch {
    // ignore
  }
}
