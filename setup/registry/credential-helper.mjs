#!/usr/bin/env node
/**
 * docker-credential-nanoclaw — vends a short-lived password for the gated
 * agent-image registry, one pull at a time.
 *
 * Docker execs this once per `docker pull`, argv `["get"]`, with the bare
 * registry hostname on stdin, before DNS resolution. `~/.docker/config.json`
 * routes only our registry here via a single `credHelpers` entry, which holds
 * a pointer and never a secret.
 *
 * Two properties are load-bearing:
 *
 * **Zero repo dependency.** Docker spawns this from an arbitrary cwd, and
 * uninstalling NanoClaw deletes the checkout while this file stays on PATH.
 * Node builtins only, nothing resolved relative to the tree, no cwd assumption.
 *
 * **Stdout is a protocol channel, not a log.** The docker CLI reads stdout and
 * matches two strings literally — `credentials not found in native keychain`
 * is the one that means "no credential here, continue anonymously". Any other
 * stdout on a non-zero exit is shown to the user verbatim, so it has to be one
 * useful line. Docker gives the helper its own stderr, so diagnostics go there
 * and reach the terminal alongside whatever docker prints next.
 *
 * The installed copy's shebang is rewritten to an absolute node path by
 * setup/install-cred-helper.ts — nvm/asdf shims are not reliably resolvable
 * from docker's spawn environment.
 */
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { arch, homedir, platform } from 'node:os';
import { join } from 'node:path';

/** Also the marker the installer greps for before deleting a binary. */
const HELPER_ID = 'nanoclaw-docker-credential-helper';
const HELPER_VERSION = '1.0.0';

const CONFIG_DIR = join(homedir(), '.config', 'nanoclaw');
/**
 * Written by sign-in. `{ api, token }` are required — the broker base and the
 * opaque bearer. `registry` (the one host this install serves) and `host_id`
 * (mint-log attribution) are optional and only tighten behaviour. `broker_url`
 * is accepted as a synonym for `api`.
 */
const AUTH_FILE = join(CONFIG_DIR, 'registry-auth.json');
/** Written by container/pull.sh for the duration of one pull. */
const NONCE_FILE = join(CONFIG_DIR, '.pull-nonce');
/** Broker-only random id. Deliberately not the PostHog install id. */
const HOST_ID_FILE = join(CONFIG_DIR, 'host-id');

/**
 * The docker CLI compares these against the helper's stdout, trimmed, byte for
 * byte. `credentials not found` is downgraded to "no credential for this
 * registry" and the pull continues unauthenticated; anything else becomes a
 * hard error carrying our text. Do not reword them.
 */
const ERR_NOT_FOUND = 'credentials not found in native keychain';
const ERR_NO_SERVER_URL = 'no credentials server URL';

/** A nonce older than this is a leftover from a crashed pull, not a live one. */
const NONCE_MAX_AGE_MS = 5 * 60_000;
const BROKER_TIMEOUT_MS = 20_000;
/** Stdin is one hostname or one small JSON object. Nothing legitimate is big. */
const MAX_STDIN_BYTES = 64 * 1024;

/**
 * Carries what stdout gets (`message`, the one line docker surfaces) separately
 * from what stderr gets (`detail`, as long as it is useful).
 */
class HelperError extends Error {
  constructor(message, detail) {
    super(message);
    this.detail = detail;
  }
}

function note(line) {
  try {
    process.stderr.write(`docker-credential-nanoclaw: ${line}\n`);
  } catch (_err) {
    // stderr can be closed or a broken pipe; diagnostics are best-effort.
  }
}

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

/** Bare hostname, lower-cased — what docker sends and what ECR is keyed by. */
function normalizeHost(raw) {
  const trimmed = (raw ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const slash = trimmed.indexOf('/');
  return (slash === -1 ? trimmed : trimmed.slice(0, slash)).toLowerCase();
}

async function readStdin() {
  // A human running this by hand gets an empty read rather than a hang.
  if (process.stdin.isTTY) return '';
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_STDIN_BYTES) throw new HelperError('input too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * The auth file, or null when this machine has never logged in. A read error
 * that is not "absent" is reported rather than silently read as "no account" —
 * an unreadable token file is a broken install, not an unenrolled one.
 */
function readAuth() {
  let raw;
  try {
    const st = statSync(AUTH_FILE);
    if (st.mode & 0o077) {
      note(`${AUTH_FILE} is readable beyond your account — chmod 600 it`);
    }
    raw = readFileSync(AUTH_FILE, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw new HelperError(
      'nanoclaw: could not read the NanoClaw registry credential',
      `${AUTH_FILE}: ${errText(err)}`,
    );
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    throw new HelperError(
      'nanoclaw: the NanoClaw registry credential file is not valid JSON',
      `${AUTH_FILE}: ${errText(err)} — re-run \`nanoclaw login\``,
    );
  }
}

function writeAuth(auth) {
  writeFileSync(AUTH_FILE, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
}

function equalConstantTime(a, b) {
  const left = Buffer.from(a, 'utf-8');
  const right = Buffer.from(b, 'utf-8');
  // Length is not secret — both sides are fixed-width random strings.
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Refuse to mint outside a NanoClaw pull.
 *
 * This file sits 0755 on PATH and answers `get` with a live 12-hour registry
 * password, so by itself it is a standing oracle: any process running as this
 * user — a malicious npm postinstall, a compromised dev tool — could mint a
 * credential that our own telemetry attributes to the legitimate account. The
 * nonce narrows that to processes inside a real pull: the environment variable
 * shows the caller was handed it by container/pull.sh, and the 0600 file shows
 * the value came from something that can write our config directory.
 *
 * It is not a boundary against an attacker who can read both — same uid, same
 * files. It removes the always-available oracle, which is the whole claim.
 */
function requirePullNonce() {
  const refuse = (detail) =>
    new HelperError(
      'nanoclaw: refusing to mint a registry credential outside a NanoClaw pull',
      detail,
    );

  const provided = (process.env.NANOCLAW_PULL_NONCE ?? '').trim();
  if (!provided) {
    throw refuse(
      'NANOCLAW_PULL_NONCE is unset. container/pull.sh sets it for the pull it runs; nothing else should be asking for a registry credential.',
    );
  }

  let st;
  let expected;
  try {
    st = statSync(NONCE_FILE);
    expected = readFileSync(NONCE_FILE, 'utf-8').trim();
  } catch (err) {
    throw refuse(`no pull nonce at ${NONCE_FILE}: ${errText(err)}`);
  }

  if (st.mode & 0o077) {
    throw refuse(`${NONCE_FILE} is accessible beyond your account — it must be 0600`);
  }
  const ageMs = Date.now() - st.mtimeMs;
  if (ageMs > NONCE_MAX_AGE_MS) {
    throw refuse(
      `the pull nonce is ${Math.round(ageMs / 1000)}s old — a leftover from an interrupted pull, not a live one`,
    );
  }
  if (!expected || !equalConstantTime(provided, expected)) {
    throw refuse('NANOCLAW_PULL_NONCE does not match the current pull');
  }
}

/** Optional, client-asserted, and recorded by the broker as a hint only. */
function pullDigest() {
  const ref = (process.env.NANOCLAW_PULL_REF ?? '').trim();
  const match = ref.match(/@(sha256:[0-9a-f]{64})$/);
  return match ? match[1] : undefined;
}

function hostId(auth) {
  if (typeof auth.host_id === 'string' && auth.host_id.trim()) return auth.host_id.trim();
  try {
    const value = readFileSync(HOST_ID_FILE, 'utf-8').trim();
    return value && value.length <= 128 ? value : undefined;
  } catch (_err) {
    // Sign-in writes both; absence costs the broker one telemetry field.
    return undefined;
  }
}

/**
 * Never send the bearer token in the clear. Loopback is exempt so a broker can
 * be exercised locally without a certificate.
 */
function brokerBase(auth) {
  const configured = [auth.api, auth.broker_url].find((v) => typeof v === 'string' && v.trim());
  const raw = configured ? configured.trim() : '';
  if (!raw) {
    throw new HelperError(
      'nanoclaw: no credential broker configured for this machine',
      `${AUTH_FILE} names no broker — re-run \`nanoclaw login\``,
    );
  }
  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    throw new HelperError('nanoclaw: the configured credential broker URL is unusable', `${raw}: ${errText(err)}`);
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !loopback) {
    throw new HelperError(
      'nanoclaw: refusing to send the pull token to a non-HTTPS broker',
      `${raw} is not https and not loopback`,
    );
  }
  return raw.replace(/\/+$/, '');
}

/** One short line from the broker, safe to append to the message docker shows. */
function brokerMessage(body) {
  const raw = body && typeof body === 'object' ? (body.message ?? body.error) : undefined;
  if (typeof raw !== 'string') return '';
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 0 && oneLine.length <= 200 ? oneLine : '';
}

/**
 * Two accepted response shapes, both natural readings of the broker's generic
 * `mint() -> { credential, expires_at }` contract: `credential` as
 * `{ username, password }`, or as a bare password string (username defaults to
 * `AWS`, which is what ECR expects).
 */
function toDockerCredential(payload, serverURL) {
  const credential = payload && typeof payload === 'object' && 'credential' in payload ? payload.credential : payload;

  let username = 'AWS';
  let secret;
  if (typeof credential === 'string') {
    secret = credential;
  } else if (credential && typeof credential === 'object') {
    if (typeof credential.username === 'string' && credential.username) username = credential.username;
    secret = credential.password ?? credential.secret;
  }

  if (typeof secret !== 'string' || !secret) {
    throw new HelperError(
      'nanoclaw: the credential broker returned no usable registry password',
      'expected { credential: { username, password } } or { credential: "<password>" }',
    );
  }
  return { ServerURL: serverURL, Username: username, Secret: secret };
}

async function mint(auth, serverURL) {
  const body = {
    perk: 'agent-image',
    registry: serverURL,
    digest: pullDigest(),
    install_id: hostId(auth),
    client: {
      os: platform(),
      arch: arch(),
      node: process.versions.node,
      helper: HELPER_VERSION,
    },
  };

  let res;
  try {
    res = await fetch(`${brokerBase(auth)}/v1/credentials`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': `${HELPER_ID}/${HELPER_VERSION} (${platform()}; ${arch()})`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BROKER_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof HelperError) throw err;
    throw new HelperError(
      'nanoclaw: could not reach the NanoClaw credential broker',
      `${errText(err)} — check network access, then retry`,
    );
  }

  const text = await res.text().catch(() => '');
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch (_err) {
    payload = undefined;
  }

  if (res.ok) return toDockerCredential(payload, serverURL);

  const reason = brokerMessage(payload);
  const suffix = reason ? ` — ${reason}` : '';
  const detail = `HTTP ${res.status} from the broker: ${text.slice(0, 500)}`;
  if (res.status === 401 || res.status === 403) {
    throw new HelperError(
      `nanoclaw: this machine is not signed in, or its image access was revoked — run \`nanoclaw login\`${suffix}`,
      detail,
    );
  }
  if (res.status === 429) {
    // Quota exhaustion is a product behaviour, not an incident. Say what it is
    // and stop; the operator's fallback is ./container/build.sh.
    throw new HelperError(`nanoclaw: image-pull quota reached for this account${suffix}`, detail);
  }
  if (res.status >= 500) {
    throw new HelperError(`nanoclaw: the credential broker is temporarily unavailable${suffix}`, detail);
  }
  throw new HelperError(`nanoclaw: the credential broker refused this request (HTTP ${res.status})${suffix}`, detail);
}

async function get(serverURL) {
  if (!serverURL) throw new HelperError(ERR_NO_SERVER_URL);

  const auth = readAuth();
  if (!auth) {
    note(`no ${AUTH_FILE} — run \`nanoclaw login\` if this machine should pull the hardened agent image`);
    throw new HelperError(ERR_NOT_FOUND);
  }

  // A host we do not serve is not an error: answering "not found" is what lets
  // docker fall through to whatever else the operator has configured. An
  // unrecorded registry skips the check rather than refusing everything — the
  // only route to this helper is a credHelpers entry the installer wired to one
  // host, and the broker decides what it will mint regardless of what we ask.
  const registry = normalizeHost(auth.registry);
  if (registry && registry !== serverURL) {
    note(`asked for ${serverURL}; this install holds a credential for ${registry}`);
    throw new HelperError(ERR_NOT_FOUND);
  }

  requirePullNonce();

  if (typeof auth.token !== 'string' || !auth.token) {
    throw new HelperError(
      'nanoclaw: the NanoClaw registry credential is incomplete — run `nanoclaw login`',
      `${AUTH_FILE} has no token`,
    );
  }

  return mint(auth, serverURL);
}

/**
 * `docker logout <host>`. Drops cached credential fields and keeps the pull
 * token: the token is the account's enrolment, not a docker session, and a
 * logout must not silently unenrol the machine. Never fails the command —
 * docker treats a non-zero erase as a failed logout.
 */
function erase(serverURL) {
  try {
    const auth = readAuth();
    if (!auth) return;
    const registry = normalizeHost(auth.registry);
    if (registry && registry !== serverURL) return;
    if (auth.cached === undefined) return;
    delete auth.cached;
    writeAuth(auth);
  } catch (err) {
    note(`erase left ${AUTH_FILE} untouched: ${errText(err)}`);
  }
}

async function dispatch(argv) {
  const command = argv[0];
  switch (command) {
    case 'get':
      return { code: 0, line: JSON.stringify(await get(normalizeHost(await readStdin()))) };
    case 'store':
      // Docker calls this after `docker login`. We persist nothing it hands us
      // — no secret is meant to land on disk here — but failing would break a
      // login the operator ran by hand against some other registry.
      await readStdin();
      return { code: 0 };
    case 'erase':
      erase(normalizeHost(await readStdin()));
      return { code: 0 };
    case 'list':
      // Empty by design. `docker build`/`compose` enumerate credentials by
      // calling `list` and then `get` on every entry returned, which would mint
      // — and burn quota — on commands that never touch our registry. The
      // per-registry credHelpers entry routes real pulls to `get` directly.
      return { code: 0, line: '{}' };
    case 'version':
      return { code: 0, line: `${HELPER_ID} ${HELPER_VERSION}` };
    default:
      return { code: 1, line: `unknown credential helper command: ${command ?? '(none)'}` };
  }
}

/**
 * Single exit point. Writing to a pipe is asynchronous in Node, so exiting
 * before the flush callback can truncate the credential JSON docker is reading.
 */
function finish(code, line) {
  if (line === undefined) {
    process.exit(code);
    return;
  }
  process.stdout.write(`${line}\n`, () => process.exit(code));
}

dispatch(process.argv.slice(2)).then(
  ({ code, line }) => finish(code, line),
  (err) => {
    if (err instanceof HelperError) {
      if (err.detail) note(err.detail);
      finish(1, err.message);
      return;
    }
    note(errText(err));
    finish(1, 'nanoclaw: the credential helper failed unexpectedly');
  },
);
