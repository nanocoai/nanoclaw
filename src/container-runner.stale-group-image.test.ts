/**
 * A group with extra packages runs its own image, built FROM the agent image.
 * When the agent image is rebuilt (update, setup, manual build), the group's
 * image is rebuilt at host start or when the group next spawns. A stub `docker` on PATH plays the
 * daemon: it reports the agent image id and the group image's derived-from
 * label, and a build stamps the current agent image id, as the real one does.
 * A `build-hold` file keeps a build running until the test removes it.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SupervisedHandle } from './drivers/session-events.js';
import type { SessionSpec } from './drivers/types.js';

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const root = mkdtempSync(join(tmpdir(), 'stale-group-image-'));
  return { root, dataDir: join(root, 'data'), groupsDir: join(root, 'groups') };
});
const { prepare, capabilities } = vi.hoisted(() => ({
  prepare: vi.fn(),
  capabilities: vi.fn(() => ({ imageBuild: true })),
}));

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: fixture.dataDir,
  GROUPS_DIR: fixture.groupsDir,
  CONTAINER_IMAGE: 'nanoclaw-agent:fixture',
  CONTAINER_IMAGE_BASE: 'nanoclaw-agent',
}));
vi.mock('./drivers/index.js', () => {
  const driver = { kind: 'fake', listSessions: async () => [], prepare, capabilities };
  return { getSessionDriver: () => driver, isSessionEventsDriver: () => false };
});
vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  isContainerRunning,
  killContainer,
  refreshStaleGroupImage,
  refreshStaleGroupImages,
  wakeContainer,
} from './container-runner.js';
import {
  ensureContainerConfig,
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from './db/container-configs.js';
import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from './db/index.js';
import { type GatewaySessionInput, resetGatewayProvider } from './gateway-providers/index.js';
import { log } from './log.js';
import type { Session } from './types.js';

const GROUP_TAG = 'nanoclaw-agent:ag-1';
const binDir = path.join(fixture.root, 'bin');
const callsDir = path.join(fixture.root, 'calls');
const stateDir = path.join(fixture.root, 'state');
const originalPath = process.env.PATH;

function setAgentImage(id: string): void {
  fs.writeFileSync(path.join(stateDir, 'base-id'), id);
}
function setGroupImageBuiltOn(label: string | null): void {
  const file = path.join(stateDir, 'label');
  if (label === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, label);
}
function failBuilds(fail: boolean): void {
  const file = path.join(stateDir, 'build-fails');
  if (fail) fs.writeFileSync(file, '');
  else fs.rmSync(file, { force: true });
}
function holdBuilds(hold: boolean): void {
  const file = path.join(stateDir, 'build-hold');
  if (hold) fs.writeFileSync(file, '');
  else fs.rmSync(file, { force: true });
}
function dockerCalls(command: 'build' | 'image'): string[][] {
  return fs
    .readdirSync(callsDir)
    .sort((a, b) => Number(a) - Number(b))
    .map((name) => fs.readFileSync(path.join(callsDir, name), 'utf8').replace(/\n$/, '').split('\n'))
    .filter((argv) => argv[0] === command);
}
const builds = () => dockerCalls('build');

beforeAll(() => {
  fs.mkdirSync(fixture.dataDir, { recursive: true });
  fs.mkdirSync(binDir);
  fs.mkdirSync(stateDir);
  // `image inspect --format <fmt> <ref>`: $5 is the ref.
  fs.writeFileSync(
    path.join(binDir, 'docker'),
    `#!/bin/sh
n=$(ls "${callsDir}" | wc -l | tr -d ' ')
printf '%s\\n' "$@" > "${callsDir}/$n"
if [ "$1" = image ]; then
  if [ "$5" = nanoclaw-agent:fixture ]; then cat "${stateDir}/base-id"; exit 0; fi
  [ -f "${stateDir}/label" ] || { echo "Error: No such image: $5" >&2; exit 1; }
  cat "${stateDir}/label"; exit 0
fi
if [ "$1" = build ]; then
  while [ -f "${stateDir}/build-hold" ]; do sleep 0.05; done
  [ -f "${stateDir}/build-fails" ] && { echo "E: Unable to locate package curl" >&2; exit 1; }
  cp "${stateDir}/base-id" "${stateDir}/label"
fi
exit 0
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

beforeEach(async () => {
  fs.rmSync(callsDir, { recursive: true, force: true });
  fs.mkdirSync(callsDir);
  setAgentImage('sha256:new');
  setGroupImageBuiltOn('sha256:old');
  failBuilds(false);
  holdBuilds(false);
  capabilities.mockReturnValue({ imageBuild: true });
  vi.mocked(log.warn).mockClear();
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig('ag-1');
  await updateContainerConfigJson('ag-1', 'packages_apt', ['curl']);
  await updateContainerConfigScalars('ag-1', { image_tag: GROUP_TAG });
});

afterEach(async () => {
  await closeDb();
});

describe('refreshStaleGroupImage', () => {
  it('rebuilds a group image built on an older agent image', async () => {
    await refreshStaleGroupImage('ag-1', GROUP_TAG);
    expect(builds()).toHaveLength(1);
    expect(builds()[0]).toContain(GROUP_TAG);
    expect((await getContainerConfig('ag-1'))?.image_tag).toBe(GROUP_TAG);
  });

  it('leaves a group image built on the current agent image alone', async () => {
    setGroupImageBuiltOn('sha256:new');
    await refreshStaleGroupImage('ag-1', GROUP_TAG);
    expect(builds()).toHaveLength(0);
  });

  it('rebuilds an image with no derived-from label, or one that is gone', async () => {
    setGroupImageBuiltOn('<no value>');
    await refreshStaleGroupImage('ag-1', GROUP_TAG);
    setAgentImage('sha256:newer');
    setGroupImageBuiltOn(null);
    await refreshStaleGroupImage('ag-1', GROUP_TAG);
    expect(builds()).toHaveLength(2);
  });

  it('never touches a pin to an image this host did not build, or a runtime that cannot build', async () => {
    await refreshStaleGroupImage('ag-1', 'registry.example/custom:1');
    await refreshStaleGroupImage('ag-1', null);
    capabilities.mockReturnValue({ imageBuild: false });
    await refreshStaleGroupImage('ag-1', GROUP_TAG);
    expect(fs.readdirSync(callsDir)).toHaveLength(0);
  });

  it('leaves a group pinned to its own image alone once all its packages are removed', async () => {
    // Its own agent image id: if this ever regresses, the failed-build memo must not skip later tests.
    setAgentImage('sha256:no-packages');
    await updateContainerConfigJson('ag-1', 'packages_apt', []);
    await refreshStaleGroupImage('ag-1', GROUP_TAG);
    expect(fs.readdirSync(callsDir)).toHaveLength(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('skips a group re-pinned to another image after the check was queued', async () => {
    await updateContainerConfigScalars('ag-1', { image_tag: 'registry.example/custom:1' });
    await refreshStaleGroupImage('ag-1', GROUP_TAG);
    expect(builds()).toHaveLength(0);
  });

  it('keeps a re-pin made while the rebuild runs', async () => {
    holdBuilds(true);
    const refresh = refreshStaleGroupImage('ag-1', GROUP_TAG);
    await vi.waitFor(() => expect(builds()).toHaveLength(1));
    await updateContainerConfigScalars('ag-1', { image_tag: 'registry.example/custom:1' });
    holdBuilds(false);
    await refresh;
    expect((await getContainerConfig('ag-1'))?.image_tag).toBe('registry.example/custom:1');
  });

  it('runs one check when several spawns of the same group ask at the same time', async () => {
    await Promise.all([1, 2, 3].map(() => refreshStaleGroupImage('ag-1', GROUP_TAG)));
    expect(builds()).toHaveLength(1);
    // Agent image and label for the check, agent image again for the build's label.
    expect(dockerCalls('image')).toHaveLength(3);
  });

  it('keeps the old image on a failed build and retries only once the agent image changes', async () => {
    failBuilds(true);
    await expect(refreshStaleGroupImage('ag-1', GROUP_TAG)).resolves.toBeUndefined();
    await refreshStaleGroupImage('ag-1', GROUP_TAG);
    expect(builds()).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not rebuild the group image'),
      expect.objectContaining({ agentGroupId: 'ag-1', fix: 'ncl groups restart --id ag-1 --rebuild' }),
    );

    failBuilds(false);
    setAgentImage('sha256:newer');
    await refreshStaleGroupImage('ag-1', GROUP_TAG);
    expect(builds()).toHaveLength(2);
  });

  it('checks every group at startup', async () => {
    await refreshStaleGroupImages();
    expect(builds()).toHaveLength(1);
  });
});

describe('spawn', () => {
  const ensure = vi.fn(async (_input: GatewaySessionInput) => ({
    contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' as const } } },
  }));
  const now = new Date().toISOString();
  const session: Session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now,
    created_at: now,
  };

  beforeEach(() => {
    prepare.mockReset();
    prepare.mockImplementation(
      async (spec: SessionSpec) =>
        ({
          key: spec.key,
          name: 'nanoclaw-v2-sess-1',
          async start() {},
          async stop() {},
          async status() {
            return { phase: 'running' };
          },
          onTerminal() {},
        }) as unknown as SupervisedHandle,
    );
    resetGatewayProvider({
      kind: 'fixture',
      agentSkills: [],
      sessions: { ensure },
      approvals: { subscribe: async () => {} },
    });
  });

  afterEach(async () => {
    holdBuilds(false);
    if (isContainerRunning('sess-1')) {
      killContainer('sess-1', 'test-teardown');
      await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));
    }
    resetGatewayProvider();
  });

  it('starts the rebuild of a stale group image without holding the spawn', async () => {
    holdBuilds(true);
    await createSession(session);
    expect(await wakeContainer(session)).toBe(true);
    const spec = prepare.mock.calls[0]?.[0] as SessionSpec;
    expect(spec.containers.find((c) => c.role === 'agent')?.image).toBe(GROUP_TAG);
    await vi.waitFor(() => expect(builds()).toHaveLength(1));
    holdBuilds(false);
    await vi.waitFor(() => expect(fs.readFileSync(path.join(stateDir, 'label'), 'utf8')).toBe('sha256:new'));
  });
});
