/**
 * Apple Container driver tests — the fixture spec through the real driver
 * against a fake `container` CLI. Replaces the pre-seam
 * `container-runtime-apple.test.ts`: every behavioral pin from that file that
 * still has a home lives here (hardening arg shape, gateway env rewrite,
 * nested-file-mount drop, system-start ensureReady, label-scoped reaping).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  AppleContainerSessionDriver,
  appleHardeningArgs,
  dropClobberingFileMounts,
  ensureAppleContainerRunning,
  rewriteHostDockerInternalEnv,
} from './apple-container-driver.js';
import { FakeCli } from './fake-cli.js';
import { FIXTURE_POLICY, fixtureSpec } from './spec-fixture.js';
import { LABELS, type MountSpec } from './types.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// The driver re-checks mount sources exist; fixture paths are not real files.
vi.mock('fs', () => ({ default: { existsSync: vi.fn(() => true), statSync: vi.fn(() => ({ isFile: () => false })) } }));

// Gateway resolution shells the real `container` binary; pin it via the
// operator override so tests never touch the host runtime.
process.env.CONTAINER_HOST_GATEWAY = '192.168.64.1';

let cli: FakeCli;

function driver(): AppleContainerSessionDriver {
  return new AppleContainerSessionDriver({ ...FIXTURE_POLICY, cli });
}

beforeEach(() => {
  cli = new FakeCli('container');
  // prepare() probes for an existing session by name; default to "not found".
  cli.responses = [{ match: /^inspect /, throws: 'no such container' }];
});

describe('appleHardeningArgs', () => {
  it('never emits --security-opt or --pids-limit (rejected with exit 64 on this runtime)', () => {
    const args = appleHardeningArgs(fixtureSpec({ resources: { pidsLimit: 256 } }));
    expect(args).not.toContain('--security-opt');
    expect(args.join(' ')).not.toContain('--pids-limit');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--init');
    expect(args.join(' ')).toContain('--ulimit nproc=256');
  });

  it('omits the nproc cap when pidsLimit is unset or nonpositive', () => {
    expect(appleHardeningArgs(fixtureSpec({ resources: {} })).join(' ')).not.toContain('nproc');
    expect(appleHardeningArgs(fixtureSpec({ resources: { pidsLimit: 0 } })).join(' ')).not.toContain('nproc');
  });
});

describe('rewriteHostDockerInternalEnv', () => {
  it('rewrites the hostname inside env values (VMs cannot resolve it; no --add-host exists)', () => {
    const out = rewriteHostDockerInternalEnv(
      { HTTPS_PROXY: 'http://user@host.docker.internal:10255', OTHER: 'untouched' },
      '192.168.64.1',
    );
    expect(out.HTTPS_PROXY).toBe('http://user@192.168.64.1:10255');
    expect(out.OTHER).toBe('untouched');
  });
});

describe('dropClobberingFileMounts', () => {
  const dir = (containerPath: string): MountSpec => ({
    class: 'group-state',
    hostPath: `/host${containerPath}`,
    containerPath,
    mode: 'rw',
    groupScope: 'g1',
  });
  const file = (containerPath: string, mode: 'ro' | 'rw' = 'ro'): MountSpec => ({
    class: 'install-surface',
    hostPath: `/host${containerPath}`,
    containerPath,
    mode,
    groupScope: 'g1',
  });

  it('drops a FILE mount nested inside a directory share (apple/container#2148) in either mode', () => {
    const isFile = (p: string): boolean => p.endsWith('.json');
    const mounts = [dir('/workspace/agent'), file('/workspace/agent/container.json'), file('/tmp/ca.pem')];
    const kept = dropClobberingFileMounts(
      mounts.map((m) => (m.containerPath.endsWith('.json') ? { ...m, hostPath: m.hostPath } : m)),
      isFile,
    );
    expect(kept.map((m) => m.containerPath)).toEqual(['/workspace/agent', '/tmp/ca.pem']);
  });

  it('keeps nested DIRECTORY mounts — only file shares replace the parent', () => {
    const isFile = (): boolean => false;
    const mounts = [dir('/workspace'), dir('/workspace/agent')];
    expect(dropClobberingFileMounts(mounts, isFile)).toHaveLength(2);
  });
});

describe('ensureAppleContainerRunning', () => {
  it('does nothing when system status succeeds', () => {
    const fake = new FakeCli('container');
    ensureAppleContainerRunning(fake);
    expect(fake.calls.map((c) => c.args.join(' '))).toEqual(['system status']);
  });

  it('starts the runtime when status fails (cold boot / stale vmnet is routine)', () => {
    const fake = new FakeCli('container');
    fake.responses = [{ match: /^system status/, throws: 'not running' }];
    ensureAppleContainerRunning(fake);
    expect(fake.calls.map((c) => c.args.join(' '))).toEqual(['system status', 'system start']);
  });

  it('throws when start also fails', () => {
    const fake = new FakeCli('container');
    fake.responses = [
      { match: /^system status/, throws: 'not running' },
      { match: /^system start/, throws: 'no' },
    ];
    expect(() => ensureAppleContainerRunning(fake)).toThrow(/failed to start/i);
  });
});

describe('prepare', () => {
  it('creates with apple-safe args: labels, hardening, mounts, entrypoint split', async () => {
    await driver().prepare(fixtureSpec({ resources: { pidsLimit: 128 } }));
    const create = cli.calls.find((c) => c.args[0] === 'create');
    expect(create).toBeDefined();
    const joined = create!.args.join(' ');
    expect(joined).toContain('--rm');
    expect(joined).toContain(`--label ${LABELS.install}=spike`);
    expect(joined).toContain(`--label ${LABELS.role}=agent`);
    expect(joined).not.toContain('--security-opt');
    expect(joined).toContain('--ulimit nproc=128');
    expect(joined).toContain('--entrypoint bash');
    expect(joined).toContain('-v /install/data/v2-sessions/g1/s1:/workspace');
  });

  it('rewrites host.docker.internal in env before the container sees it', async () => {
    const spec = fixtureSpec();
    spec.containers[0] = {
      ...spec.containers[0],
      contributedEnv: { HTTPS_PROXY: 'http://token@host.docker.internal:10255' },
    };
    await driver().prepare(spec);
    const create = cli.calls.find((c) => c.args[0] === 'create')!;
    const joined = create.args.join(' ');
    expect(joined).toContain('HTTPS_PROXY=http://token@192.168.64.1:10255');
    expect(joined).not.toContain('host.docker.internal');
  });

  it('refuses auxiliary containers (capabilities().auxiliaryContainers is false)', async () => {
    const spec = fixtureSpec();
    spec.containers = [...spec.containers, { ...spec.containers[0], role: 'egress-proxy' }];
    await expect(driver().prepare(spec)).rejects.toThrow(/auxiliary/i);
  });
});

describe('listSessions / reapResidue', () => {
  const entry = (
    id: string,
    state: string,
    labels: Record<string, string>,
  ): { status: { state: string }; configuration: { id: string; labels: Record<string, string> } } => ({
    status: { state },
    configuration: { id, labels },
  });

  it('filters by install + role labels client-side (no --filter on this CLI)', async () => {
    cli.responses = [
      {
        match: /^list /,
        output: JSON.stringify([
          entry('ours-1', 'running', {
            [LABELS.install]: 'spike',
            [LABELS.role]: 'agent',
            [LABELS.group]: 'g1',
            [LABELS.session]: 's1',
          }),
          entry('peer', 'running', {
            [LABELS.install]: 'other-install',
            [LABELS.role]: 'agent',
            [LABELS.group]: 'gx',
            [LABELS.session]: 'sx',
          }),
        ]),
      },
    ];
    const sessions = await driver().listSessions('spike');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].handle.name).toBe('ours-1');
    expect(sessions[0].phase).toBe('running');
  });

  it('accepts both status shapes (plain string through 0.12.x, {state} from 1.0.0)', async () => {
    cli.responses = [
      {
        match: /^list /,
        output: JSON.stringify([
          {
            status: 'running',
            configuration: {
              id: 'legacy',
              labels: {
                [LABELS.install]: 'spike',
                [LABELS.role]: 'agent',
                [LABELS.group]: 'g1',
                [LABELS.session]: 's1',
              },
            },
          },
        ]),
      },
    ];
    const sessions = await driver().listSessions('spike');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].phase).toBe('running');
  });

  it('reaps only this install: deletes stale entries, stops pre-seam runners, spares peers', async () => {
    cli.responses = [
      {
        match: /^list /,
        output: JSON.stringify([
          entry('stale-ours', 'stopped', { [LABELS.install]: 'spike' }),
          entry('preseam-ours', 'running', { [LABELS.install]: 'spike' }),
          entry('peer-stale', 'stopped', { [LABELS.install]: 'other' }),
        ]),
      },
    ];
    await driver().reapResidue('spike');
    const cmds = cli.calls.map((c) => c.args.join(' '));
    expect(cmds).toContain('rm --force stale-ours');
    expect(cmds).toContain('stop preseam-ours');
    expect(cmds.join('\n')).not.toContain('peer-stale');
  });
});
