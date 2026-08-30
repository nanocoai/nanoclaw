/**
 * Session management for nostr-signer daemon.
 * Issues short-lived tokens scoped to specific event kinds.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const SESSION_FILE = process.env.SIGNER_SESSION_FILE
  || path.join(process.env.HOME || '/tmp', '.config/nanoclaw/signer-sessions.json');

// In-memory session store (persisted to disk for crash recovery)
const sessions = new Map();

function ensureDir() {
  const dir = path.dirname(SESSION_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function persist() {
  ensureDir();
  const data = {};
  for (const [token, session] of sessions) {
    data[token] = session;
  }
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
}

function loadFromDisk() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      const now = Date.now();
      for (const [token, session] of Object.entries(data)) {
        if (session.expiresAt > now) {
          sessions.set(token, session);
        }
      }
      console.log(`[sessions] Loaded ${sessions.size} active session(s) from disk`);
    }
  } catch (err) {
    console.warn(`[sessions] Failed to load sessions: ${err.message}`);
  }
}

/**
 * Create a new session token.
 * @param {number[]} allowedKinds - Event kinds this session can sign
 * @param {number} ttlSeconds - Time to live in seconds (default 8 hours)
 * @param {number|null} pid - PID of the requesting process (for origin validation)
 * @returns {{ token: string, expiresAt: number, allowedKinds: number[] }}
 */
export function createSession(allowedKinds, ttlSeconds = 28800, pid = null) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const session = {
    token,
    allowedKinds,
    createdAt: now,
    expiresAt: now + (ttlSeconds * 1000),
    pid,
    signCount: 0,
  };
  sessions.set(token, session);
  persist();
  console.log(`[sessions] Created session ${token.slice(0, 12)}... scope=[${allowedKinds}] ttl=${ttlSeconds}s pid=${pid || 'any'}`);
  return { token, expiresAt: session.expiresAt, allowedKinds };
}

/**
 * Validate a session token for a specific event kind.
 * @param {string} token - Session token
 * @param {number} eventKind - The event kind being signed
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateSession(token, eventKind) {
  const session = sessions.get(token);
  if (!session) {
    return { valid: false, error: 'Invalid session token' };
  }

  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    persist();
    return { valid: false, error: 'Session expired' };
  }

  if (!session.allowedKinds.includes(eventKind)) {
    return { valid: false, error: `Event kind ${eventKind} not in session scope [${session.allowedKinds}]` };
  }

  // Increment sign count
  session.signCount++;
  return { valid: true };
}

/**
 * Revoke a session token.
 * @param {string} token
 */
export function revokeSession(token) {
  if (sessions.delete(token)) {
    persist();
    console.log(`[sessions] Revoked session ${token.slice(0, 12)}...`);
    return true;
  }
  return false;
}

/**
 * Get session info (for diagnostics).
 * @param {string} token
 */
export function getSessionInfo(token) {
  const session = sessions.get(token);
  if (!session) return null;
  return {
    allowedKinds: session.allowedKinds,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    signCount: session.signCount,
    expired: Date.now() > session.expiresAt,
  };
}

/**
 * Prune expired sessions.
 */
export function pruneExpired() {
  const now = Date.now();
  let pruned = 0;
  for (const [token, session] of sessions) {
    if (now > session.expiresAt) {
      sessions.delete(token);
      pruned++;
    }
  }
  if (pruned > 0) {
    persist();
    console.log(`[sessions] Pruned ${pruned} expired session(s)`);
  }
}

// Load existing sessions on import
loadFromDisk();

// Prune expired sessions every 5 minutes
setInterval(pruneExpired, 5 * 60 * 1000);
