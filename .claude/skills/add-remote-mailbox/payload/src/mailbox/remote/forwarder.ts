/**
 * The mailbox forwarder: under egress lockdown, the one hop from the
 * locked-down agent network to the host mailbox service.
 *
 * With NANOCLAW_EGRESS_LOCKDOWN=true, Docker agent containers sit on the
 * `--internal` EGRESS_NETWORK, whose `host.docker.internal` is the credential
 * gateway — they cannot reach a host port at all. This module keeps one
 * long-lived container per install that joins that network under a
 * per-install alias and forwards exactly one TCP port, the mailbox port, to
 * the host. Remote-mailbox containers on the locked network then use
 * `http://<alias>:<port>/v1/mailbox` (see `issueRemoteMailboxEnv`).
 *
 * The container:
 *   - runs the install's agent image (it ships `node`; nothing new is pulled)
 *     with an inline Node forwarder: one listen port, one fixed host target;
 *   - is on EGRESS_NETWORK with the alias `nanoclaw-mailbox-<slug>` (the
 *     network is shared by every install on the daemon, so the alias carries
 *     the slug) and on the default `bridge`, from which the host is reachable;
 *   - reaches the host by a name of its own mapped to Docker's `host-gateway`
 *     (`host.docker.internal` may resolve to the gateway on the locked network);
 *   - carries `nanoclaw-install=<slug>` so the slug-scoped uninstall removes
 *     it, and `nanoclaw-role=gateway` with no session: the install's
 *     residue reaping and update drain leave such containers running, which a
 *     host-independent network hop needs;
 *   - runs non-root, all capabilities dropped, no-new-privileges, read-only
 *     root filesystem, small memory and pid caps, `--restart unless-stopped`.
 *
 * Linux: the host service binds 127.0.0.1, which `host-gateway` (the docker
 * bridge address) does not reach. Docker Desktop for macOS forwards
 * `host-gateway` to the Mac's loopback; that is the tested platform.
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';

import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { GATEWAY_ROLE, LABELS } from '../../drivers/types.js';
import { log } from '../../log.js';

/** Label carrying the hash of the forwarder's configuration; a mismatch recreates it. */
export const FORWARDER_CONFIG_LABEL = 'nanoclaw-mailbox-forwarder';
/** Name the forwarder resolves the host by (an /etc/hosts entry mapped to `host-gateway`). */
export const FORWARDER_HOST_NAME = 'nanoclaw-mailbox-host';
/** The non-internal network the forwarder reaches the host from. */
export const FORWARDER_UPLINK_NETWORK = 'bridge';
const FORWARDER_USER = '1000:1000';
const DOCKER_TIMEOUT_MS = 30_000;

/**
 * argv: <listenPort> <host> <hostPort>. Forwards every connection to the one
 * target; nothing else is reachable through it.
 */
export const FORWARDER_SCRIPT = [
  "const net = require('net');",
  'const [listenPort, host, hostPort] = process.argv.slice(1);',
  'net.createServer((client) => {',
  '  const upstream = net.connect(Number(hostPort), host);',
  '  const close = () => { client.destroy(); upstream.destroy(); };',
  "  client.on('error', close); upstream.on('error', close);",
  "  client.on('close', close); upstream.on('close', close);",
  '  client.pipe(upstream).pipe(client);',
  "}).listen(Number(listenPort), '0.0.0.0');",
  "process.on('SIGTERM', () => process.exit(0));",
].join('\n');

/** Container name and network alias of an install's forwarder. */
export function mailboxForwarderName(installSlug: string): string {
  return `nanoclaw-mailbox-${installSlug}`;
}

export interface ForwarderOptions {
  installSlug: string;
  port: number;
  image: string;
  network: string;
}

export interface EnsureForwarderOptions extends ForwarderOptions {
  /** NANOCLAW_EGRESS_LOCKDOWN. */
  lockdown: boolean;
  /** At least one agent group uses the remote mailbox. */
  enabled: boolean;
}

export class MailboxForwarderError extends Error {
  constructor(reason: string) {
    super(`Remote mailbox under egress lockdown: ${reason}. Listed agent groups could not reach their mailbox.`);
    this.name = 'MailboxForwarderError';
  }
}

function docker(args: string[]): string {
  return execFileSync(CONTAINER_RUNTIME_BIN, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: DOCKER_TIMEOUT_MS,
  }).trim();
}

function isMissing(err: unknown): boolean {
  const { stderr, message } = err as { stderr?: unknown; message?: unknown };
  return /no such (object|container|network|image)|not found/i.test(`${String(stderr ?? '')} ${String(message ?? '')}`);
}

function detail(err: unknown): string {
  const { stderr, message } = err as { stderr?: unknown; message?: unknown };
  return (String(stderr ?? '').trim() || String(message ?? err)).split('\n')[0];
}

/** The configuration hash: any change to it (port, image build, network, alias, script) recreates the forwarder. */
export function forwarderConfigHash(opts: ForwarderOptions, imageId: string): string {
  const parts = [opts.port, imageId, opts.network, mailboxForwarderName(opts.installSlug), FORWARDER_SCRIPT];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/** `docker create` argv for the forwarder; it joins the uplink network separately before it starts. */
export function forwarderCreateArgs(opts: ForwarderOptions, configHash: string): string[] {
  const name = mailboxForwarderName(opts.installSlug);
  return [
    'create',
    '--name',
    name,
    '--label',
    `${LABELS.install}=${opts.installSlug}`,
    '--label',
    `${LABELS.role}=${GATEWAY_ROLE}`,
    '--label',
    `${FORWARDER_CONFIG_LABEL}=${configHash}`,
    '--restart',
    'unless-stopped',
    '--user',
    FORWARDER_USER,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--memory',
    '64m',
    '--pids-limit',
    '64',
    '--network',
    opts.network,
    '--network-alias',
    name,
    '--add-host',
    `${FORWARDER_HOST_NAME}:host-gateway`,
    '--entrypoint',
    'node',
    opts.image,
    '-e',
    FORWARDER_SCRIPT,
    String(opts.port),
    FORWARDER_HOST_NAME,
    String(opts.port),
  ];
}

/** `{ hash, status }` of the existing forwarder, or undefined when there is none. */
function inspectForwarder(name: string): { hash: string; status: string } | undefined {
  try {
    const out = docker([
      'inspect',
      name,
      '--format',
      `{{index .Config.Labels "${FORWARDER_CONFIG_LABEL}"}}|{{.State.Status}}`,
    ]);
    const [hash = '', status = ''] = out.split('|');
    return { hash, status };
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw new MailboxForwarderError(`the forwarder container could not be inspected (${detail(err)})`);
  }
}

/** The locked network must exist and be internal; create it when missing, as core's lockdown would. */
function ensureLockedNetwork(network: string): void {
  let internal: string;
  try {
    internal = docker(['network', 'inspect', network, '--format', '{{.Internal}}']);
  } catch (err) {
    if (!isMissing(err)) {
      throw new MailboxForwarderError(`the "${network}" network could not be inspected (${detail(err)})`);
    }
    try {
      docker(['network', 'create', '--internal', network]);
      return;
    } catch (createErr) {
      throw new MailboxForwarderError(`the "${network}" internal network could not be created (${detail(createErr)})`);
    }
  }
  if (internal !== 'true') throw new MailboxForwarderError(`the "${network}" network is not internal`);
}

function removeForwarder(name: string): void {
  try {
    docker(['rm', '--force', name]);
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
}

function createForwarder(opts: ForwarderOptions, configHash: string): void {
  const name = mailboxForwarderName(opts.installSlug);
  try {
    docker(forwarderCreateArgs(opts, configHash));
    docker(['network', 'connect', FORWARDER_UPLINK_NETWORK, name]);
    docker(['start', name]);
  } catch (err) {
    try {
      removeForwarder(name);
    } catch {
      /* best effort: the next start recreates it */
    }
    throw new MailboxForwarderError(`the forwarder container could not be started (${detail(err)})`);
  }
}

export type ForwarderOutcome = 'absent' | 'removed' | 'kept' | 'started' | 'created' | 'recreated';

/**
 * Make the forwarder match the settings. Lockdown on with listed groups: it
 * exists with this configuration and runs (created, recreated or started as
 * needed), or this throws. Otherwise: a leftover one is removed.
 */
export function ensureMailboxForwarder(opts: EnsureForwarderOptions): ForwarderOutcome {
  const name = mailboxForwarderName(opts.installSlug);

  if (!opts.lockdown || !opts.enabled) {
    // Not needed. Clean up a stale one, but never fail startup over it.
    try {
      if (!inspectForwarder(name)) return 'absent';
      removeForwarder(name);
      log.info('Remote mailbox forwarder removed (not needed)', { container: name });
      return 'removed';
    } catch (err) {
      log.warn('Remote mailbox forwarder could not be checked or removed', { container: name, err });
      return 'absent';
    }
  }

  ensureLockedNetwork(opts.network);
  let imageId: string;
  try {
    imageId = docker(['image', 'inspect', opts.image, '--format', '{{.Id}}']);
  } catch (err) {
    throw new MailboxForwarderError(`the agent image "${opts.image}" is not available (${detail(err)})`);
  }
  const hash = forwarderConfigHash(opts, imageId);
  const current = inspectForwarder(name);

  let outcome: ForwarderOutcome;
  if (!current) {
    createForwarder(opts, hash);
    outcome = 'created';
  } else if (current.hash !== hash) {
    try {
      removeForwarder(name);
    } catch (err) {
      throw new MailboxForwarderError(`the outdated forwarder container could not be removed (${detail(err)})`);
    }
    createForwarder(opts, hash);
    outcome = 'recreated';
  } else if (current.status !== 'running') {
    try {
      docker(['start', name]);
    } catch (err) {
      throw new MailboxForwarderError(`the forwarder container could not be started (${detail(err)})`);
    }
    outcome = 'started';
  } else {
    outcome = 'kept';
  }

  const status = inspectForwarder(name)?.status;
  if (status !== 'running') {
    throw new MailboxForwarderError(`the forwarder container is ${status ?? 'missing'} after start`);
  }
  log.info('Remote mailbox forwarder up', {
    container: name,
    network: opts.network,
    alias: name,
    port: opts.port,
    outcome,
  });
  return outcome;
}
