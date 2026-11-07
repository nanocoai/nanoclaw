#!/usr/bin/env node
/**
 * Nostr Signing Daemon
 *
 * Reads the nsec from the Linux kernel keyring at startup,
 * holds it only in process memory, and signs Nostr events
 * on request via a Unix socket.
 *
 * The agent can USE the key without ever SEEING the key.
 *
 * Security layers:
 * - Session tokens with TTL and event-kind scope
 * - Per-session rate limiting
 * - Legacy mode (no token) supported with deprecation warning
 */

import { execSync } from 'child_process';
import { createServer } from 'net';
import { existsSync, unlinkSync, appendFileSync, mkdirSync, chmodSync } from 'fs';
import { dirname } from 'path';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { decode as decodeNsec } from 'nostr-tools/nip19';
import { unwrapEvent as nip17Unwrap, wrapManyEvents as nip17WrapMany } from 'nostr-tools/nip17';
import * as nip44 from 'nostr-tools/nip44';
import * as nip04 from 'nostr-tools/nip04';
import { createSession, validateSession, revokeSession, getSessionInfo } from './sessions.js';
import { checkRate, clearRate, getRateStats } from './rate-limiter.js';

// --- Alert log ---
const ALERT_LOG = process.env.SIGNER_ALERT_LOG
  || `${process.env.HOME || '/tmp'}/NanoClaw/groups/main/status/signer-alerts.log`;

function logAlert(msg) {
  try {
    const dir = dirname(ALERT_LOG);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(ALERT_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* best effort */ }
  console.warn(`[nostr-signer] ALERT: ${msg}`);
}

// --- Load keys from kernel keyring ---
// The default account uses the keyring key named `nsec` and is required. Its name comes from
// NOSTR_SIGNER_DEFAULT_ACCOUNT (falls back to "default"; "default" always works as an alias).
// Extra accounts are discovered automatically: every user key named `nostr:<account>` in the
// user keyring is loaded. Add one with add-account-key.sh, then restart the daemon.
// Only get_public_key and sign_event accept an `account` param; DM and encryption methods
// always use the default key.
const DEFAULT_ACCOUNT = process.env.NOSTR_SIGNER_DEFAULT_ACCOUNT || 'default';
const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function loadKeyById(keyId) {
  const nsec = execSync(`keyctl print ${keyId}`, { encoding: 'utf8' }).trim();
  const decoded = decodeNsec(nsec);
  if (decoded.type !== 'nsec') throw new Error('Keyring value is not an nsec');
  return decoded.data;
}

function loadKey(description) {
  const keyId = execSync(`keyctl search @u user ${description}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return loadKeyById(keyId);
}

/** Account names of all `nostr:<name>` user keys in the user keyring, mapped to key IDs. */
function discoverExtraAccounts() {
  const found = new Map();
  let ids = [];
  try {
    ids = execSync('keyctl rlist @u', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/).filter(Boolean);
  } catch { /* empty keyring */ }
  for (const id of ids) {
    let desc;
    try {
      desc = execSync(`keyctl rdescribe ${id}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { continue; }
    // Format: type;uid;gid;perm;description
    const [type, , , , ...rest] = desc.split(';');
    const description = rest.join(';');
    if (type !== 'user' || !description.startsWith('nostr:')) continue;
    const name = description.slice('nostr:'.length);
    if (ACCOUNT_NAME_RE.test(name) && name !== DEFAULT_ACCOUNT && name !== 'default') found.set(name, id);
  }
  return found;
}

const accounts = new Map(); // account name -> { secretKeyHex, pubkey }

try {
  const sk = loadKey('nsec');
  accounts.set(DEFAULT_ACCOUNT, { secretKeyHex: sk, pubkey: getPublicKey(sk) });
  console.log('[nostr-signer] Key loaded from kernel keyring');
} catch (err) {
  // NEVER log err.message — nostr-tools includes the raw key value in decode errors
  console.error('[nostr-signer] Failed to load key from keyring. Ensure the `nsec` key contains ONLY the nsec1... string (no extra lines or whitespace).');
  process.exit(1);
}

for (const [name, keyId] of discoverExtraAccounts()) {
  try {
    const sk = loadKeyById(keyId);
    accounts.set(name, { secretKeyHex: sk, pubkey: getPublicKey(sk) });
  } catch {
    // Same rule: never log err.message
    console.warn(`[nostr-signer] Account "${name}" not loaded (nostr:${name} is not a valid nsec)`);
  }
}

const { secretKeyHex, pubkey } = accounts.get(DEFAULT_ACCOUNT);
for (const [name, acct] of accounts) {
  console.log(`[nostr-signer] Public key (${name}): ${acct.pubkey}`);
}

/** Resolve the `account` request param; returns null for an unknown/unloaded account. */
function resolveAccount(p) {
  const name = !p.account || p.account === 'default' ? DEFAULT_ACCOUNT : p.account;
  return accounts.get(name) || null;
}

function unknownAccountError(p) {
  return JSON.stringify({ error: `Unknown or unloaded account: ${p.account}. Loaded: ${[...accounts.keys()].join(', ')}` });
}

// Track legacy (no-token) usage to log deprecation
let legacyWarningLogged = false;

// --- Socket path ---
const SOCKET_PATH = process.env.NOSTR_SIGNER_SOCKET
  || `${process.env.XDG_RUNTIME_DIR || '/run/user/1000'}/nostr-signer.sock`;

// Clean up stale socket
if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);

// --- Handle requests ---
async function handleRequest(data) {
  try {
    const req = JSON.parse(data);

    if (req.method === 'get_public_key') {
      const p = req.params || {};
      const acct = resolveAccount(p);
      if (!acct) return unknownAccountError(p);
      return JSON.stringify({ pubkey: acct.pubkey });
    }

    if (req.method === 'list_accounts') {
      return JSON.stringify({
        accounts: [...accounts].map(([name, acct]) => ({ name, pubkey: acct.pubkey, default: name === DEFAULT_ACCOUNT })),
      });
    }

    // --- Session management ---
    if (req.method === 'session_start') {
      const p = req.params || {};
      const scope = (p.scope || '1,9734,1111').split(',').map(Number);
      const ttl = parseInt(p.ttl || '28800', 10);
      const session = createSession(scope, ttl, p.pid || null);
      return JSON.stringify({ session });
    }

    if (req.method === 'session_revoke') {
      const p = req.params || {};
      if (!p.token) return JSON.stringify({ error: 'Missing required field: token' });
      const revoked = revokeSession(p.token);
      clearRate(p.token);
      return JSON.stringify({ revoked });
    }

    if (req.method === 'session_info') {
      const p = req.params || {};
      if (!p.token) return JSON.stringify({ error: 'Missing required field: token' });
      const info = getSessionInfo(p.token);
      const rateStats = getRateStats(p.token);
      return JSON.stringify({ session: info, rateStats });
    }

    // --- sign_event (with optional session token) ---
    if (req.method === 'sign_event') {
      const p = req.params || {};
      if (p.kind === undefined) return JSON.stringify({ error: 'Missing required field: kind' });
      if (p.content === undefined) return JSON.stringify({ error: 'Missing required field: content' });
      const acct = resolveAccount(p);
      if (!acct) return unknownAccountError(p);

      // Session validation (if token provided)
      if (p.session_token) {
        const sv = validateSession(p.session_token, p.kind);
        if (!sv.valid) {
          logAlert(`sign_event rejected: ${sv.error} (kind=${p.kind}, token=${p.session_token.slice(0, 12)}...)`);
          return JSON.stringify({ error: sv.error });
        }

        // Rate limiting
        const rl = checkRate(p.session_token);
        if (!rl.allowed) {
          logAlert(`sign_event rate-limited: ${rl.error} (token=${p.session_token.slice(0, 12)}...)`);
          return JSON.stringify({ error: rl.error });
        }
      } else {
        // Legacy mode — no session token
        if (!legacyWarningLogged) {
          console.warn('[nostr-signer] DEPRECATION: sign_event called without session_token. Use session_start to create a scoped session.');
          legacyWarningLogged = true;
        }
      }

      const eventTemplate = {
        kind: p.kind,
        content: p.content,
        tags: p.tags || [],
        created_at: p.created_at || Math.floor(Date.now() / 1000),
      };

      const signedEvent = finalizeEvent(eventTemplate, acct.secretKeyHex);
      return JSON.stringify({ event: signedEvent });
    }

    if (req.method === 'unwrap_gift_wrap') {
      const p = req.params || {};
      if (!p.event) return JSON.stringify({ error: 'Missing required field: event' });
      const rl = checkRate('__crypto_ops');
      if (!rl.allowed) {
        logAlert(`unwrap_gift_wrap rate-limited: ${rl.error}`);
        return JSON.stringify({ error: rl.error });
      }
      try {
        const rumor = nip17Unwrap(p.event, secretKeyHex);
        return JSON.stringify({ rumor });
      } catch (err) {
        return JSON.stringify({ error: `Unwrap failed: ${err.message}` });
      }
    }

    if (req.method === 'wrap_dm') {
      const p = req.params || {};
      if (!p.recipientPubkey) return JSON.stringify({ error: 'Missing required field: recipientPubkey' });
      const rl = checkRate('__crypto_ops');
      if (!rl.allowed) {
        logAlert(`wrap_dm rate-limited: ${rl.error}`);
        return JSON.stringify({ error: rl.error });
      }
      if (p.message === undefined) return JSON.stringify({ error: 'Missing required field: message' });
      try {
        const recipients = [{ publicKey: p.recipientPubkey }];
        const events = nip17WrapMany(secretKeyHex, recipients, p.message, p.conversationTitle, p.replyTo);
        return JSON.stringify({ events });
      } catch (err) {
        return JSON.stringify({ error: `Wrap failed: ${err.message}` });
      }
    }

    if (req.method === 'nip44_encrypt') {
      const p = req.params || {};
      if (!p.plaintext) return JSON.stringify({ error: 'Missing required field: plaintext' });
      if (!p.peer_pubkey) return JSON.stringify({ error: 'Missing required field: peer_pubkey' });
      const rl = checkRate('__crypto_ops');
      if (!rl.allowed) return JSON.stringify({ result: null, error: rl.error });
      try {
        const convKey = nip44.v2.utils.getConversationKey(secretKeyHex, p.peer_pubkey);
        const ciphertext = nip44.v2.encrypt(p.plaintext, convKey);
        return JSON.stringify({ result: ciphertext, error: null });
      } catch (err) {
        return JSON.stringify({ result: null, error: `nip44_encrypt failed: ${err.message}` });
      }
    }

    if (req.method === 'nip44_decrypt') {
      const p = req.params || {};
      if (!p.ciphertext) return JSON.stringify({ error: 'Missing required field: ciphertext' });
      if (!p.peer_pubkey) return JSON.stringify({ error: 'Missing required field: peer_pubkey' });
      const rl = checkRate('__crypto_ops');
      if (!rl.allowed) return JSON.stringify({ result: null, error: rl.error });
      try {
        const convKey = nip44.v2.utils.getConversationKey(secretKeyHex, p.peer_pubkey);
        const plaintext = nip44.v2.decrypt(p.ciphertext, convKey);
        return JSON.stringify({ result: plaintext, error: null });
      } catch (err) {
        return JSON.stringify({ result: null, error: `nip44_decrypt failed: ${err.message}` });
      }
    }

    if (req.method === 'nip04_encrypt') {
      const p = req.params || {};
      if (!p.plaintext && !p.message) return JSON.stringify({ error: 'Missing required field: plaintext' });
      if (!p.recipientPubkey && !p.peer_pubkey) return JSON.stringify({ error: 'Missing required field: recipientPubkey' });
      try {
        const text = p.plaintext || p.message;
        const peer = p.recipientPubkey || p.peer_pubkey;
        const ciphertext = await nip04.encrypt(secretKeyHex, peer, text);
        return JSON.stringify({ ciphertext, error: null });
      } catch (err) {
        return JSON.stringify({ error: `nip04_encrypt failed: ${err.message}` });
      }
    }

    if (req.method === 'nip04_decrypt') {
      const p = req.params || {};
      if (!p.ciphertext && !p.content) return JSON.stringify({ error: 'Missing required field: ciphertext' });
      if (!p.senderPubkey && !p.peer_pubkey) return JSON.stringify({ error: 'Missing required field: senderPubkey' });
      try {
        const cipher = p.ciphertext || p.content;
        const peer = p.senderPubkey || p.peer_pubkey;
        const plaintext = await nip04.decrypt(secretKeyHex, peer, cipher);
        return JSON.stringify({ plaintext, error: null });
      } catch (err) {
        return JSON.stringify({ error: `nip04_decrypt failed: ${err.message}` });
      }
    }

    return JSON.stringify({ error: `Unknown method: ${req.method}` });
  } catch (err) {
    return JSON.stringify({ error: `Parse error: ${err.message}` });
  }
}

// --- Start server ---
const server = createServer((conn) => {
  let buf = '';
  conn.setEncoding('utf8');
  conn.on('data', async (chunk) => {
    buf += chunk;
    // Newline-delimited JSON framing: process each complete line
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const response = await handleRequest(trimmed);
        conn.write(response + '\n');
      } catch (err) {
        conn.write(JSON.stringify({ error: err.message }) + '\n');
      }
    }
    // Fallback: if client sends JSON without trailing newline (legacy), detect complete object
    if (buf.length > 0) {
      try {
        JSON.parse(buf);
        const input = buf;
        buf = '';
        try {
          const response = await handleRequest(input);
          conn.end(response + '\n');
        } catch (err) {
          conn.end(JSON.stringify({ error: err.message }) + '\n');
        }
      } catch {
        // Incomplete JSON, wait for more data
      }
    }
  });
  conn.on('end', () => {
    // Process any remaining data in buffer
    if (buf.trim()) {
      handleRequest(buf.trim()).then(
        (response) => { /* connection already ended */ },
        () => { /* swallow */ }
      );
    }
  });
});

server.listen(SOCKET_PATH, () => {
  chmodSync(SOCKET_PATH, 0o600);
  console.log(`[nostr-signer] Listening on ${SOCKET_PATH}`);
  console.log(`[nostr-signer] Session management: enabled`);
  console.log(`[nostr-signer] Rate limiting: enabled (10/min, 100/hr)`);
  console.log(`[nostr-signer] Legacy mode: allowed (with deprecation warning)`);
});

// --- Graceful shutdown ---
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[nostr-signer] ${sig} received, shutting down`);
    server.close();
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
    process.exit(0);
  });
}
