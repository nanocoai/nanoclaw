/**
 * The remote-mailbox driver against the real core: registration through the
 * real drivers barrel, and spawn / exit / adoption through the real
 * container-runner and session-events hub. Only the runtime (Docker) is faked;
 * every spec it receives passes the real `validateSpec` mount policy.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DriverCapabilities, SessionDriver, SessionHandle, SessionKey, SessionSpec } from '../../drivers/types.js';

const ROOT = `/tmp/nanoclaw-test-remote-mailbox-driver-${process.pid}`;
const fake = vi.hoisted(() => ({
  specs: [] as unknown[],
  stops: [] as string[],
  listed: [] as unknown[],
  driver: null as unknown,
  lockdown: false,
  inner: 'docker',
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  const root = `/tmp/nanoclaw-test-remote-mailbox-driver-${process.pid}`;
  return {
    ...actual,
    DATA_DIR: `${root}/data`,
    GROUPS_DIR: `${root}/groups`,
    get EGRESS_LOCKDOWN() {
      return fake.lockdown;
    },
  };
});
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    REMOTE_MAILBOX_GROUPS: ['ag-remote'],
    MAILBOX_PORT: 18999,
    get REMOTE_MAILBOX_INNER_DRIVER() {
      return fake.inner;
    },
  };
});
vi.mock('../../drivers/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../drivers/index.js')>('../../drivers/index.js');
  return { ...actual, getSessionDriver: () => fake.driver, peekSessionDriver: () => fake.driver };
});

import {
  abortGatewaySessionObservers,
  adoptRunningSessions,
  isContainerRunning,
  killContainer,
  wakeContainer,
} from '../../container-runner.js';
import { INSTALL_SLUG } from '../../config.js';
import { ensureContainerConfig } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from '../../db/index.js';
import {
  createSessionDriver,
  listSessionDriverKinds,
  mountPolicy,
  validateSpec,
  withSessionEvents,
} from '../../drivers/index.js';
import { resetGatewayProvider } from '../../gateway-providers/index.js';
import { heartbeatPath } from '../../session-manager.js';
import type { Session } from '../../types.js';
import {
  REMOTE_HEARTBEAT_CONTAINER_DIR,
  REMOTE_HEARTBEAT_CONTAINER_PATH,
  REMOTE_MAILBOX_DRIVER_KIND,
  rewriteRemoteMailboxSpec,
  warnIfDriverNotSelected,
  withRemoteMailbox,
} from './driver.js';
import { log } from '../../log.js';
import { issueRemoteMailboxEnv, remoteHeartbeatDir, remoteHeartbeatFile, sessionHeartbeatPath } from './spawn.js';
import { verifyMailboxToken } from './tokens.js';
import { mailboxForwarderName } from './forwarder.js';
import { fixtureSpec } from '../../drivers/spec-fixture.js';
import { registerSessionDriver } from '../../drivers/driver-registry.js';

const CAPS: DriverCapabilities = {
  isolationTiers: ['container'],
  admissionEnforced: false,
  networkPolicy: 'topology',
  encryptedVolumes: false,
  unrealized: [],
  sharedNetworkNamespace: false,
  auxiliaryContainers: false,
  imageBuild: true,
};

function handleFor(key: SessionKey): SessionHandle {
  return {
    key,
    name: `nanoclaw-v2-${key.sessionId}`,
    async start() {},
    async stop(reason) {
      fake.stops.push(reason);
    },
    async status() {
      return { phase: 'running' };
    },
    execSpec: () => ({ bin: 'docker', argsTty: [], argsPlain: [] }),
  };
}

/** Stands in for the `docker` driver: validates against the real mount policy, starts nothing. */
const inner: SessionDriver = {
  kind: 'docker',
  capabilities: () => CAPS,
  async prepare(spec) {
    validateSpec(spec, mountPolicy(), CAPS);
    fake.specs.push(spec);
    return handleFor(spec.key);
  },
  async listSessions() {
    return fake.listed as Awaited<ReturnType<SessionDriver['listSessions']>>;
  },
  watchSessions: () => ({ stop() {} }),
};

const sessionOf = (agentGroupId: string): Session => {
  const now = new Date().toISOString();
  return {
    id: 'sess-1',
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now,
    created_at: now,
  };
};

const remoteKey = { agentGroupId: 'ag-remote', sessionId: 'sess-1' };
const tokenFile = (group: string) => path.join(ROOT, 'data', 'mailbox-tokens', group, 'sess-1');
const scratchDir = path.join(ROOT, 'data/v2-sessions/ag-remote/.remote-workspace/sess-1');
const lastSpec = (): SessionSpec => fake.specs.at(-1) as SessionSpec;
const agentOf = (spec: SessionSpec) => spec.containers.find((c) => c.role === 'agent')!;
const mountAt = (spec: SessionSpec, target: string) => agentOf(spec).mounts.find((m) => m.containerPath === target);
const allEnv = (spec: SessionSpec) => ({ ...agentOf(spec).env, ...agentOf(spec).contributedEnv });

beforeEach(async () => {
  fake.specs = [];
  fake.stops = [];
  fake.listed = [];
  fake.lockdown = false;
  fake.inner = 'docker';
  fake.driver = withSessionEvents(withRemoteMailbox(inner));
  resetGatewayProvider({
    kind: 'fixture',
    agentSkills: [],
    sessions: {
      ensure: async () => ({
        contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' as const } } },
      }),
    },
    approvals: { subscribe: async () => {} },
  });
  await runMigrations(await initTestDb());
  for (const [id, folder] of [
    ['ag-remote', 'remote-agent'],
    ['ag-plain', 'plain-agent'],
  ]) {
    await createAgentGroup({ id, name: id, folder, agent_provider: null, created_at: new Date().toISOString() });
    await ensureContainerConfig(id);
  }
});

afterEach(async () => {
  if (isContainerRunning('sess-1')) {
    killContainer('sess-1', 'test-teardown');
    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));
  }
  resetGatewayProvider();
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('registration', () => {
  it('the real drivers barrel registers the remote-mailbox kind, wrapping docker', () => {
    expect(listSessionDriverKinds()).toEqual(expect.arrayContaining(['docker', REMOTE_MAILBOX_DRIVER_KIND]));
    const driver = createSessionDriver(REMOTE_MAILBOX_DRIVER_KIND);
    expect(driver.kind).toMatch(/^remote-mailbox\(docker/);
  });

  it('wraps the driver NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER names instead', () => {
    registerSessionDriver('stub-inner', () => ({ ...inner, kind: 'stub-inner' }));
    fake.inner = 'stub-inner';
    expect(createSessionDriver(REMOTE_MAILBOX_DRIVER_KIND).kind).toBe('remote-mailbox(stub-inner)');
    fake.inner = 'absent';
    expect(() => createSessionDriver(REMOTE_MAILBOX_DRIVER_KIND)).toThrow(/no 'absent' driver/);
    fake.inner = REMOTE_MAILBOX_DRIVER_KIND;
    expect(() => createSessionDriver(REMOTE_MAILBOX_DRIVER_KIND)).toThrow(/cannot name the remote-mailbox driver/);
  });
});

describe('spawn through the real container-runner', () => {
  it('opted-in group: scratch /workspace, heartbeat file, mailbox env, live token', async () => {
    await createSession(sessionOf('ag-remote'));
    expect(await wakeContainer(sessionOf('ag-remote'))).toBe(true);
    const spec = lastSpec();

    const sessDir = path.join(ROOT, 'data', 'v2-sessions', 'ag-remote', 'sess-1');
    expect(agentOf(spec).mounts.some((m) => m.hostPath === sessDir)).toBe(false);
    expect(mountAt(spec, '/workspace')).toMatchObject({
      hostPath: scratchDir,
      mode: 'rw',
      class: 'group-state',
      groupScope: 'ag-remote',
    });
    expect(fs.readdirSync(scratchDir)).toEqual([]);
    // Composition's other mounts are untouched.
    const targets = agentOf(spec).mounts.map((m) => m.containerPath);
    expect(targets).toEqual(expect.arrayContaining(['/workspace/agent', '/app/.nanoclaw-session.json']));

    // Heartbeat: a file in a bound directory, named by env, hard-linked where
    // the sweep reads it. Core deletes the session heartbeat before prepare();
    // the link surviving proves prepare() ran after that delete.
    expect(mountAt(spec, REMOTE_HEARTBEAT_CONTAINER_DIR)).toMatchObject({
      hostPath: remoteHeartbeatDir(remoteKey),
      mode: 'rw',
      class: 'group-state',
    });
    expect(REMOTE_HEARTBEAT_CONTAINER_PATH).toBe(`${REMOTE_HEARTBEAT_CONTAINER_DIR}/heartbeat`);
    expect(path.dirname(remoteHeartbeatFile(remoteKey))).toBe(remoteHeartbeatDir(remoteKey));
    expect(agentOf(spec).env.NANOCLAW_HEARTBEAT_PATH).toBe(REMOTE_HEARTBEAT_CONTAINER_PATH);
    expect(sessionHeartbeatPath(remoteKey)).toBe(heartbeatPath('ag-remote', 'sess-1'));
    expect(fs.statSync(heartbeatPath('ag-remote', 'sess-1')).ino).toBe(fs.statSync(remoteHeartbeatFile(remoteKey)).ino);

    const env = allEnv(spec);
    expect(env.NANOCLAW_MAILBOX_URL).toBe('http://host.docker.internal:18999/v1/mailbox');
    expect(env.NANOCLAW_MAILBOX_SESSION).toBe('ag-remote/sess-1');
    expect(env.NO_PROXY).toBe('host.docker.internal');
    expect(agentOf(spec).contributedEnv?.NANOCLAW_MAILBOX_TOKEN).toBeDefined();
    expect(verifyMailboxToken(`Bearer ${env.NANOCLAW_MAILBOX_TOKEN}`, 'ag-remote/sess-1')).toEqual(remoteKey);
  });

  it('group not opted in: the spec reaches docker exactly as composed', async () => {
    await createSession(sessionOf('ag-plain'));
    expect(await wakeContainer(sessionOf('ag-plain'))).toBe(true);
    const spec = lastSpec();
    expect(mountAt(spec, '/workspace')?.hostPath).toBe(path.join(ROOT, 'data', 'v2-sessions', 'ag-plain', 'sess-1'));
    expect(mountAt(spec, REMOTE_HEARTBEAT_CONTAINER_DIR)).toBeUndefined();
    for (const k of [
      'NANOCLAW_MAILBOX_URL',
      'NANOCLAW_MAILBOX_TOKEN',
      'NANOCLAW_MAILBOX_SESSION',
      'NANOCLAW_HEARTBEAT_PATH',
    ]) {
      expect(allEnv(spec)[k]).toBeUndefined();
    }
    expect(fs.existsSync(path.join(ROOT, 'data', 'mailbox-tokens'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'data/v2-sessions/ag-plain/.remote-workspace'))).toBe(false);
  });

  it('revokes the token and drops the scratch state when the container ends', async () => {
    await createSession(sessionOf('ag-remote'));
    await wakeContainer(sessionOf('ag-remote'));
    const token = allEnv(lastSpec()).NANOCLAW_MAILBOX_TOKEN;

    killContainer('sess-1', 'test-exit');
    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));

    expect(fs.existsSync(tokenFile('ag-remote'))).toBe(false);
    expect(verifyMailboxToken(`Bearer ${token}`, 'ag-remote/sess-1')).toBeNull();
    expect(fs.existsSync(scratchDir)).toBe(false);
    expect(fs.existsSync(remoteHeartbeatDir(remoteKey))).toBe(false);
  });

  it('withdraws only its own token when docker refuses the spawn', async () => {
    await createSession(sessionOf('ag-remote'));
    const refusing = { ...inner, prepare: vi.fn(async () => Promise.reject(new Error('boom'))) };
    fake.driver = withSessionEvents(withRemoteMailbox(refusing));
    expect(await wakeContainer(sessionOf('ag-remote'))).toBe(false);
    expect(fs.existsSync(tokenFile('ag-remote'))).toBe(false);
  });
});

describe('mailbox host under egress lockdown', () => {
  const capture: SessionDriver = {
    ...inner,
    async prepare(spec) {
      fake.specs.push(spec);
      return handleFor(spec.key);
    },
  };
  const urlFor = async (networkAccess: SessionSpec['networkAccess']) => {
    await withRemoteMailbox(capture).prepare(
      fixtureSpec({ key: { installSlug: INSTALL_SLUG, ...remoteKey }, networkAccess }),
    );
    return allEnv(lastSpec());
  };
  const gateway = { endpoint: 'host.docker.internal', target: { kind: 'runtime' as const, identity: 'gw' } };

  it('a container on the locked network reaches the mailbox through the forwarder alias', async () => {
    fake.lockdown = true;
    const env = await urlFor(gateway);
    const alias = mailboxForwarderName(INSTALL_SLUG);
    expect(env.NANOCLAW_MAILBOX_URL).toBe(`http://${alias}:18999/v1/mailbox`);
    expect(env.NO_PROXY).toBe(`host.docker.internal,${alias}`);
  });

  it('off the locked network (no lockdown, or a session-container target) it reaches the host directly', async () => {
    expect((await urlFor(gateway)).NANOCLAW_MAILBOX_URL).toBe('http://host.docker.internal:18999/v1/mailbox');
    fake.lockdown = true;
    const sidecar = { endpoint: 'proxy', target: { kind: 'session-container' as const, role: 'proxy' } };
    expect((await urlFor(sidecar)).NANOCLAW_MAILBOX_URL).toBe('http://host.docker.internal:18999/v1/mailbox');
  });
});

describe('adopted containers', () => {
  it('keep working through adoption and host shutdown, and release when they end', async () => {
    await createSession(sessionOf('ag-remote'));
    // What the previous host left: a token and a scratch dir for a container that is still running.
    const token = issueRemoteMailboxEnv(remoteKey).NANOCLAW_MAILBOX_TOKEN;
    fs.mkdirSync(scratchDir, { recursive: true });
    fake.listed = [{ handle: handleFor({ installSlug: INSTALL_SLUG, ...remoteKey }), phase: 'running' }];

    expect((await adoptRunningSessions()).adopted).toBe(1);
    expect(isContainerRunning('sess-1')).toBe(true);
    expect(verifyMailboxToken(`Bearer ${token}`, 'ag-remote/sess-1')).toEqual(remoteKey);

    // Host shutdown detaches; it never stops the container, so nothing is released.
    await abortGatewaySessionObservers();
    expect(verifyMailboxToken(`Bearer ${token}`, 'ag-remote/sess-1')).toEqual(remoteKey);
    expect(fs.existsSync(scratchDir)).toBe(true);

    killContainer('sess-1', 'test-exit');
    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));
    expect(verifyMailboxToken(`Bearer ${token}`, 'ag-remote/sess-1')).toBeNull();
    expect(fs.existsSync(scratchDir)).toBe(false);
  });

  it('wraps only handles with remote-mailbox state; others pass through as listed', async () => {
    const plainHandle = handleFor({ installSlug: INSTALL_SLUG, agentGroupId: 'ag-plain', sessionId: 'sess-1' });
    fake.listed = [
      { handle: handleFor({ installSlug: INSTALL_SLUG, ...remoteKey }), phase: 'running' },
      { handle: plainHandle, phase: 'running' },
    ];
    const [remote, plain] = await withRemoteMailbox(inner).listSessions(INSTALL_SLUG);
    expect(plain.handle).toBe(plainHandle);
    fs.mkdirSync(scratchDir, { recursive: true });
    await remote.handle.stop('orphan-at-startup');
    expect(fs.existsSync(scratchDir)).toBe(false);
  });
});

describe('spec rewrite', () => {
  it('refuses a spec with no /workspace mount rather than guessing', () => {
    const spec = {
      key: { installSlug: 'x', ...remoteKey },
      containers: [{ role: 'agent', image: 'i', env: {}, mounts: [] }],
    } as unknown as SessionSpec;
    expect(() => rewriteRemoteMailboxSpec(spec, { workspace: '/w', heartbeatDir: '/h' }, {})).toThrow(/workspace/);
  });
});

describe('misconfiguration', () => {
  it('names the missing driver setting when groups are listed but another driver runs', () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    warnIfDriverNotSelected({ NANOCLAW_RUNTIME_DRIVER: 'remote-mailbox' });
    expect(error).not.toHaveBeenCalled();
    warnIfDriverNotSelected({ NANOCLAW_RUNTIME_DRIVER: 'docker' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('NANOCLAW_RUNTIME_DRIVER'), expect.anything());
    error.mockRestore();
  });
});
