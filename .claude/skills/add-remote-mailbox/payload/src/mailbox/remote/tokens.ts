/**
 * Per-session bearer tokens for the remote mailbox.
 *
 * Only sha256(token) is stored, in a file outside every session directory, so
 * no container can read it and verification is stateless across host restarts.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { isValidSessionKey, parseSessionHeader } from './ids.js';
import type { RemoteSessionKey } from './ids.js';

function tokensRoot(): string {
  return path.join(DATA_DIR, 'mailbox-tokens');
}

function tokenPath(key: RemoteSessionKey): string {
  return path.join(tokensRoot(), key.agentGroupId, key.sessionId);
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

const DUMMY_HASH = hashToken('nanoclaw-mailbox-dummy');
const HASH = /^[0-9a-f]{64}$/;

/**
 * How many of a session's most recent tokens stay valid. A spawn issues a new
 * token, but `prepare()` is idempotent on key: a runtime that is still live
 * (e.g. left unadopted after a hard host kill) is reused and keeps the token it
 * was started with. Replacing tokens would lock that runtime out; every token
 * still opens only its own session, and revocation clears them all.
 */
const LIVE_TOKENS_PER_SESSION = 4;

function readHashes(key: RemoteSessionKey): string[] {
  try {
    return fs
      .readFileSync(tokenPath(key), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => HASH.test(line));
  } catch {
    return [];
  }
}

/** Issue a token for one session (older ones stay valid, newest few kept). Returns the plaintext; it is never stored. */
export function issueMailboxToken(key: RemoteSessionKey): string {
  if (!isValidSessionKey(key)) throw new Error('invalid mailbox session key');
  const token = crypto.randomBytes(32).toString('base64url');
  const file = tokenPath(key);
  const dir = path.dirname(file);
  fs.mkdirSync(tokensRoot(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const hashes = [...readHashes(key), hashToken(token)].slice(-LIVE_TOKENS_PER_SESSION);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, hashes.join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return token;
}

/** Withdraw one issued token, leaving the session's other tokens valid. */
export function withdrawMailboxToken(key: RemoteSessionKey, token: string): void {
  if (!isValidSessionKey(key)) return;
  const remaining = readHashes(key).filter((hash) => hash !== hashToken(token));
  if (remaining.length === 0) {
    fs.rmSync(tokenPath(key), { force: true });
    return;
  }
  const file = tokenPath(key);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, remaining.join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function revokeMailboxToken(key: RemoteSessionKey): void {
  if (!isValidSessionKey(key)) return;
  fs.rmSync(tokenPath(key), { force: true });
}

/**
 * Verify an `authorization` header against the session named by
 * `x-nanoclaw-session`. Returns the session key, or null for any failure
 * (malformed header, unknown session, wrong token) without distinguishing them.
 */
export function verifyMailboxToken(authHeader: unknown, sessionHeader: unknown): RemoteSessionKey | null {
  const key = parseSessionHeader(sessionHeader);
  const match = typeof authHeader === 'string' ? /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(authHeader) : null;
  const stored = key ? readHashes(key) : [];
  // Always hash and compare (against a dummy when nothing is stored) so a
  // missing session costs the same as a wrong token; compare every entry.
  const presented = Buffer.from(hashToken(match ? match[1] : ''), 'hex');
  let equal = false;
  for (const hash of stored.length > 0 ? stored : [DUMMY_HASH]) {
    if (crypto.timingSafeEqual(presented, Buffer.from(hash, 'hex'))) equal = true;
  }
  return key && match && stored.length > 0 && equal ? key : null;
}

/** Whether any token is on file for this session. */
export function tokenFileExists(key: RemoteSessionKey): boolean {
  return isValidSessionKey(key) && fs.existsSync(tokenPath(key));
}
