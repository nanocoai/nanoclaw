import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  /** Existing forwarder: label hash + status, or undefined for none. */
  container: undefined as { hash: string; status: string } | undefined,
  network: 'true' as 'true' | 'false' | 'missing',
  imageId: 'sha256:img-1' as string | undefined,
  /** argv prefixes (joined by space) that fail. */
  failing: [] as string[],
  calls: [] as string[][],
  execFileSync: vi.fn(),
}));

// Partial mock, as in egress-lockdown.test.ts: other modules may use other exports.
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFileSync: state.execFileSync,
}));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { log } from '../../log.js';
import {
  ensureMailboxForwarder,
  forwarderConfigHash,
  forwarderCreateArgs,
  FORWARDER_CONFIG_LABEL,
  FORWARDER_HOST_NAME,
  mailboxForwarderName,
  MailboxForwarderError,
} from './forwarder.js';

const OPTS = { installSlug: 'abcd1234', port: 18770, image: 'nanoclaw-agent-v2-abcd1234:latest', network: 'fx-egress' };
const NAME = 'nanoclaw-mailbox-abcd1234';
const on = { ...OPTS, lockdown: true, enabled: true };

function missing(what: string): Error {
  return Object.assign(new Error('Command failed'), { stderr: `Error: No such ${what}: x` });
}

function fakeDocker(_bin: string, args: string[]): string {
  state.calls.push(args);
  const line = args.join(' ');
  if (state.failing.some((prefix) => line.startsWith(prefix))) {
    throw Object.assign(new Error('Command failed'), { stderr: 'daemon said no' });
  }
  if (args[0] === 'network' && args[1] === 'inspect') {
    if (state.network === 'missing') throw missing('network');
    return state.network;
  }
  if (args[0] === 'network' && args[1] === 'create') state.network = 'true';
  if (args[0] === 'image' && args[1] === 'inspect') {
    if (!state.imageId) throw missing('image');
    return state.imageId;
  }
  if (args[0] === 'inspect') {
    if (!state.container) throw missing('object');
    return `${state.container.hash}|${state.container.status}`;
  }
  if (args[0] === 'create') {
    const label = args.find((a) => a.startsWith(`${FORWARDER_CONFIG_LABEL}=`)) ?? '';
    state.container = { hash: label.split('=')[1], status: 'created' };
  }
  if (args[0] === 'start' && state.container) state.container.status = 'running';
  if (args[0] === 'rm') {
    if (!state.container) throw missing('container');
    state.container = undefined;
  }
  return '';
}

const verbs = () => state.calls.map((a) => (a[0] === 'network' || a[0] === 'image' ? `${a[0]} ${a[1]}` : a[0]));
const currentHash = () => forwarderConfigHash(OPTS, 'sha256:img-1');

beforeEach(() => {
  vi.clearAllMocks();
  state.container = undefined;
  state.network = 'true';
  state.imageId = 'sha256:img-1';
  state.failing = [];
  state.calls = [];
  state.execFileSync.mockReset().mockImplementation(fakeDocker);
});

describe('forwarder container spec', () => {
  it('one port to the host, on the locked network under a per-install alias, hardened and uninstall-visible', () => {
    const args = forwarderCreateArgs(OPTS, 'h1');
    const after = (flag: string) => args.filter((_, i) => args[i - 1] === flag);
    expect(mailboxForwarderName('abcd1234')).toBe(NAME);
    expect(after('--name')).toEqual([NAME]);
    expect(after('--network')).toEqual(['fx-egress']);
    expect(after('--network-alias')).toEqual([NAME]);
    expect(after('--add-host')).toEqual([`${FORWARDER_HOST_NAME}:host-gateway`]);
    // Same labels the uninstaller lists by; gateway role keeps it out of residue reaping.
    expect(after('--label')).toEqual([
      'nanoclaw-install=abcd1234',
      'nanoclaw-role=gateway',
      `${FORWARDER_CONFIG_LABEL}=h1`,
    ]);
    expect(after('--label').some((l) => l.startsWith('nanoclaw-session='))).toBe(false);
    expect(after('--restart')).toEqual(['unless-stopped']);
    expect(after('--cap-drop')).toEqual(['ALL']);
    expect(after('--user')).toEqual(['1000:1000']);
    expect(args).toContain('--read-only');
    expect(after('--entrypoint')).toEqual(['node']);
    // Image, then node's argv: -e <script> <listen> <host> <hostPort>.
    expect(args.slice(args.indexOf(OPTS.image) + 3)).toEqual(['18770', FORWARDER_HOST_NAME, '18770']);
  });

  it('the config hash follows port, image build and network', () => {
    const base = forwarderConfigHash(OPTS, 'sha256:a');
    expect(forwarderConfigHash(OPTS, 'sha256:a')).toBe(base);
    expect(forwarderConfigHash(OPTS, 'sha256:b')).not.toBe(base);
    expect(forwarderConfigHash({ ...OPTS, port: 18771 }, 'sha256:a')).not.toBe(base);
    expect(forwarderConfigHash({ ...OPTS, network: 'other' }, 'sha256:a')).not.toBe(base);
    expect(forwarderConfigHash({ ...OPTS, installSlug: 'other' }, 'sha256:a')).not.toBe(base);
  });
});

describe('ensureMailboxForwarder under lockdown', () => {
  it('creates, joins the uplink network, starts, and logs once', () => {
    expect(ensureMailboxForwarder(on)).toBe('created');
    expect(verbs()).toEqual([
      'network inspect',
      'image inspect',
      'inspect',
      'create',
      'network connect',
      'start',
      'inspect',
    ]);
    expect(state.calls.find((a) => a[1] === 'connect')).toEqual(['network', 'connect', 'bridge', NAME]);
    expect(state.container).toEqual({ hash: currentHash(), status: 'running' });
    expect(log.info).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith('Remote mailbox forwarder up', expect.objectContaining({ alias: NAME }));
  });

  it('leaves a running one with the same configuration alone', () => {
    state.container = { hash: currentHash(), status: 'running' };
    expect(ensureMailboxForwarder(on)).toBe('kept');
    expect(verbs()).not.toContain('create');
    expect(verbs()).not.toContain('rm');
    expect(verbs()).not.toContain('start');
  });

  it('starts a stopped one', () => {
    state.container = { hash: currentHash(), status: 'exited' };
    expect(ensureMailboxForwarder(on)).toBe('started');
    expect(verbs()).toContain('start');
    expect(verbs()).not.toContain('create');
  });

  it('recreates one whose configuration differs (e.g. a rebuilt image)', () => {
    state.container = { hash: forwarderConfigHash(OPTS, 'sha256:old'), status: 'running' };
    expect(ensureMailboxForwarder(on)).toBe('recreated');
    expect(verbs()).toEqual([
      'network inspect',
      'image inspect',
      'inspect',
      'rm',
      'create',
      'network connect',
      'start',
      'inspect',
    ]);
    expect(state.container?.hash).toBe(currentHash());
  });

  it('creates the internal network when missing, refuses a non-internal one', () => {
    state.network = 'missing';
    ensureMailboxForwarder(on);
    expect(state.calls).toContainEqual(['network', 'create', '--internal', 'fx-egress']);

    state.network = 'false';
    state.container = undefined;
    expect(() => ensureMailboxForwarder(on)).toThrow(/not internal/);
    expect(state.container).toBeUndefined();
  });

  it('fails clearly when the image is missing', () => {
    state.imageId = undefined;
    expect(() => ensureMailboxForwarder(on)).toThrow(MailboxForwarderError);
    expect(() => ensureMailboxForwarder(on)).toThrow(/agent image/);
  });

  it('a failed start removes the half-made container and throws', () => {
    state.failing = ['network connect'];
    expect(() => ensureMailboxForwarder(on)).toThrow(/could not be started \(daemon said no\)/);
    expect(state.container).toBeUndefined();
  });

  it('fails when docker cannot be inspected at all (daemon down)', () => {
    state.failing = ['inspect'];
    expect(() => ensureMailboxForwarder(on)).toThrow(/could not be inspected/);
  });
});

describe('ensureMailboxForwarder when not needed', () => {
  it.each([
    ['lockdown off', { ...OPTS, lockdown: false, enabled: true }],
    ['no group listed', { ...OPTS, lockdown: true, enabled: false }],
  ])('%s: removes a stale one', (_label, opts) => {
    state.container = { hash: currentHash(), status: 'running' };
    expect(ensureMailboxForwarder(opts)).toBe('removed');
    expect(state.calls).toContainEqual(['rm', '--force', NAME]);
    expect(verbs()).not.toContain('create');
  });

  it('does nothing when there is none', () => {
    expect(ensureMailboxForwarder({ ...OPTS, lockdown: false, enabled: false })).toBe('absent');
    expect(verbs()).toEqual(['inspect']);
  });

  it('never fails startup over cleanup', () => {
    state.failing = ['inspect'];
    expect(ensureMailboxForwarder({ ...OPTS, lockdown: false, enabled: true })).toBe('absent');
    expect(log.warn).toHaveBeenCalled();
  });
});
