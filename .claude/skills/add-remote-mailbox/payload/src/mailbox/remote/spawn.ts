/**
 * Spawn-time wiring for the remote mailbox (opt-in per agent group).
 *
 * An opted-in group's container gets no session-directory mount. Its runner
 * talks to the host service in `service.ts` with a per-spawn bearer token, and
 * keeps its local inbox/outbox in a scratch directory the host creates empty
 * for each session and deletes when the container ends.
 *
 * Why a scratch directory and not tmpfs: `MountSpec` has no tmpfs kind, and
 * adding one means a new seam type plus every driver and the conformance suite.
 * A per-session host directory under the group's own `v2-sessions/<group>/`
 * root is an ordinary `group-state` mount, so the driver and its policy are
 * untouched. It holds only what the runner itself writes.
 *
 * Heartbeat: the host reads `<sessionDir>/.heartbeat`. The runner touches a
 * skill-owned file, in a per-session directory mount, that is hard-linked
 * there, so the sweep and typing refresh see it without the session directory
 * being mounted. See `prepareRemoteHeartbeat`.
 *
 * Egress lockdown: under NANOCLAW_EGRESS_LOCKDOWN, a container on the locked
 * network cannot reach the host; `host.docker.internal` there is the credential
 * gateway. Such containers reach the service through the install's mailbox
 * forwarder (forwarder.ts) at its network alias instead.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, INSTALL_SLUG } from '../../config.js';
import { log } from '../../log.js';
import { sessionMailboxDir } from '../sqlite/paths.js';
import { MAILBOX_PORT, REMOTE_MAILBOX_GROUPS } from './config.js';
import { mailboxForwarderName } from './forwarder.js';
import { isValidSessionKey, type RemoteSessionKey } from './ids.js';
import { issueMailboxToken, revokeMailboxToken, tokenFileExists, withdrawMailboxToken } from './tokens.js';

export function isRemoteMailboxGroup(agentGroupId: string): boolean {
  return REMOTE_MAILBOX_GROUPS.includes(agentGroupId);
}

export function remoteMailboxEnabled(): boolean {
  return REMOTE_MAILBOX_GROUPS.length > 0;
}

function remoteRoot(key: RemoteSessionKey): string {
  return path.join(DATA_DIR, 'v2-sessions', key.agentGroupId, '.remote-workspace');
}

export function remoteWorkspaceDir(key: RemoteSessionKey): string {
  return path.join(remoteRoot(key), key.sessionId);
}

/** Name of the heartbeat file inside the heartbeat directory. */
export const REMOTE_HEARTBEAT_FILE = 'heartbeat';

/**
 * The directory mounted into the container for the heartbeat; outside the
 * scratch dir. Session ids carry no dots, so `<sessionId>.hb` never names
 * another session's scratch dir.
 */
export function remoteHeartbeatDir(key: RemoteSessionKey): string {
  return path.join(remoteRoot(key), `${key.sessionId}.hb`);
}

/** The heartbeat file the container touches. */
export function remoteHeartbeatFile(key: RemoteSessionKey): string {
  return path.join(remoteHeartbeatDir(key), REMOTE_HEARTBEAT_FILE);
}

/**
 * Where containers spawned before the heartbeat moved into a directory touch
 * their (single-file mounted) heartbeat. Kept on the same inode while such a
 * container may be live, and released with the rest.
 */
export function legacyHeartbeatFile(key: RemoteSessionKey): string {
  return path.join(remoteRoot(key), `${key.sessionId}.heartbeat`);
}

/**
 * The host's `<sessionDir>/.heartbeat` (core `heartbeatPath`). Resolved from the
 * mailbox paths module so the driver's import graph stays clear of
 * session-manager; driver.test.ts pins the two together.
 */
export function sessionHeartbeatPath(key: RemoteSessionKey): string {
  return path.join(sessionMailboxDir(key), '.heartbeat');
}

/** Whether a session has remote-mailbox state to release (a token or a scratch dir). */
export function hasRemoteMailboxState(key: RemoteSessionKey): boolean {
  if (!isValidSessionKey(key)) return false;
  return (
    tokenFileExists(key) ||
    fs.existsSync(remoteWorkspaceDir(key)) ||
    fs.existsSync(remoteHeartbeatDir(key)) ||
    fs.existsSync(legacyHeartbeatFile(key))
  );
}

/** The scratch /workspace for a remote-mailbox session (created if missing, never cleared here). */
export function prepareRemoteWorkspace(key: RemoteSessionKey): string {
  // Never clear it here: a spawn attempt can find the session's runtime still
  // live (unadopted after a hard host kill) and `prepare()` then returns that
  // runtime — wiping would delete its inbox/outbox. releaseRemoteMailbox()
  // clears it when a runtime actually ends.
  const dir = remoteWorkspaceDir(key);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The heartbeat directory to bind into the container. Its file is hard-linked
 * at the host's `<sessionDir>/.heartbeat`.
 *
 * Core deletes `<sessionDir>/.heartbeat` just before `prepare()`; this links
 * it back to the same inode the container touches. Hard link rather than a
 * fresh file: when `prepare()` reuses a live runtime, that runtime's mount
 * still reaches the existing inode, and the link keeps the host reading it.
 * A file created here gets mtime 0, which the sweep reads exactly like an
 * absent heartbeat (fresh-spawn grace), matching what core's delete means.
 */
export function prepareRemoteHeartbeat(key: RemoteSessionKey): string {
  const dir = remoteHeartbeatDir(key);
  const file = remoteHeartbeatFile(key);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) {
    const legacy = legacyHeartbeatFile(key);
    if (fs.existsSync(legacy)) {
      // A runtime from before the move may still be live: share its inode.
      fs.linkSync(legacy, file);
    } else {
      fs.writeFileSync(file, '');
      fs.utimesSync(file, 0, 0);
    }
  }
  const link = sessionHeartbeatPath(key);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.rmSync(link, { force: true });
  fs.linkSync(file, link);
  return dir;
}

/** Host name a container reaches the service by: the forwarder's alias on the locked network, else the host. */
export function mailboxHost(viaForwarder: boolean): string {
  return viaForwarder ? mailboxForwarderName(INSTALL_SLUG) : 'host.docker.internal';
}

/**
 * Issue a fresh token for this spawn and return the runner's env. Goes on the
 * contributed env lane: the token is a credential-NAMED variable, which the
 * composed lane refuses by design; the lane still refuses real credential
 * values, and this is a spawn-scoped bearer the host revokes at exit.
 *
 * `viaForwarder`: the container lands on the egress-lockdown network, so it
 * goes through the mailbox forwarder.
 */
export function issueRemoteMailboxEnv(key: RemoteSessionKey, viaForwarder = false): Record<string, string> {
  const token = issueMailboxToken(key);
  const host = mailboxHost(viaForwarder);
  const noProxy = viaForwarder ? `host.docker.internal,${host}` : host;
  return {
    NANOCLAW_MAILBOX_URL: `http://${host}:${MAILBOX_PORT}/v1/mailbox`,
    NANOCLAW_MAILBOX_TOKEN: token,
    NANOCLAW_MAILBOX_SESSION: `${key.agentGroupId}/${key.sessionId}`,
    // Bun's fetch honours HTTP(S)_PROXY, so without this the mailbox calls
    // (and their bearer token) ride the credential gateway's proxy. No gateway
    // sets NO_PROXY today; this lane wins if one ever does.
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

/**
 * Container gone (or never started): revoke its tokens and drop its scratch
 * workspace and heartbeat. Idempotent and a no-op for sessions that never
 * used the remote mailbox. NOT called on host shutdown — adopted containers
 * keep working.
 */
export function releaseRemoteMailbox(key: RemoteSessionKey): void {
  if (!isValidSessionKey(key)) return;
  try {
    revokeMailboxToken(key);
    fs.rmSync(remoteWorkspaceDir(key), { recursive: true, force: true });
    fs.rmSync(remoteHeartbeatDir(key), { recursive: true, force: true });
    fs.rmSync(legacyHeartbeatFile(key), { force: true });
  } catch (err) {
    log.warn('Remote mailbox release failed', { ...key, err });
  }
}

/**
 * A spawn attempt that failed (driver refusal) withdraws only the token it
 * issued. The session's other tokens and its scratch workspace may belong to a
 * runtime that is still live; they go when that runtime ends.
 */
export function withdrawRemoteMailboxEnv(key: RemoteSessionKey, env: Record<string, string>): void {
  const token = env.NANOCLAW_MAILBOX_TOKEN;
  if (!token) return;
  try {
    withdrawMailboxToken(key, token);
  } catch (err) {
    log.warn('Remote mailbox token withdrawal failed', { ...key, err });
  }
}
