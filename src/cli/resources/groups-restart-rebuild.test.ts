/**
 * `ncl groups restart --rebuild` × driver capabilities.
 *
 * `buildAgentGroupImage` shells `docker build`; on a runtime that declares
 * `imageBuild: false` there is nothing to run it against, so the command
 * must refuse — in the PAYLOAD, because this command exits 0 even on a
 * nonexistent group id — and it must refuse the WHOLE command: restarting
 * after silently skipping the rebuild would report success for a rebuild
 * that never happened.
 *
 * The gate reads `capabilities()`, never the driver's kind. Only the Docker
 * driver ships in this tree, so the incapable polarity is a stub declaring
 * what an out-of-tree driver (a host with no Docker daemon, images
 * arriving out of band) actually declares.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../container-restart.js', () => ({
  restartAgentGroupContainers: vi.fn().mockReturnValue(2),
}));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { buildAgentGroupImage } from '../../container-runner.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { DockerSessionDriver } from '../../drivers/docker-driver.js';
import { resetSessionDriver } from '../../drivers/index.js';
import { FIXTURE_POLICY } from '../../drivers/spec-fixture.js';
import type { SessionDriver } from '../../drivers/types.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `groups-*` commands (including restart).
import './groups.js';

type OkResponse = { ok: true; data: { restarted: number; rebuilt: boolean; error?: string } };

/** What a driver without a build daemon declares; everything else is off-path here. */
function noImageBuildDriver(): SessionDriver {
  const docker = new DockerSessionDriver(FIXTURE_POLICY);
  return {
    kind: docker.kind,
    capabilities: () => ({ ...docker.capabilities(), imageBuild: false }),
    prepare: () => Promise.reject(new Error('not under test')),
    listSessions: () => Promise.resolve([]),
    watchSessions: () => ({ stop: () => {} }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => resetSessionDriver(null));

describe('groups restart --rebuild gates on the imageBuild capability', () => {
  it('rebuilds then restarts on a driver that declares imageBuild (docker)', async () => {
    resetSessionDriver(new DockerSessionDriver(FIXTURE_POLICY));

    const resp = await dispatch(
      { id: 'r1', command: 'groups-restart', args: { id: 'ag-1', rebuild: true } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    expect((resp as OkResponse).data).toMatchObject({ restarted: 2, rebuilt: true });
    expect(buildAgentGroupImage).toHaveBeenCalledExactlyOnceWith('ag-1');
  });

  it('refuses in the payload, naming the capability, on a driver without imageBuild', async () => {
    resetSessionDriver(noImageBuildDriver());

    const resp = await dispatch(
      { id: 'r2', command: 'groups-restart', args: { id: 'ag-1', rebuild: true } },
      { caller: 'host' },
    );

    // The payload is the oracle — this command's exit is 0 either way.
    expect(resp.ok).toBe(true);
    const data = (resp as OkResponse).data;
    expect(data.rebuilt).toBe(false);
    expect(data.restarted).toBe(0);
    expect(data.error).toContain('imageBuild');
    // Refused whole: no build attempted, and no restart either — half a
    // command reporting success is how a skipped rebuild hides.
    expect(buildAgentGroupImage).not.toHaveBeenCalled();
    expect(restartAgentGroupContainers).not.toHaveBeenCalled();
  });

  it('a plain restart (no --rebuild) is untouched by the gate on either polarity', async () => {
    for (const driver of [new DockerSessionDriver(FIXTURE_POLICY), noImageBuildDriver()]) {
      vi.clearAllMocks();
      resetSessionDriver(driver);

      const resp = await dispatch(
        { id: `r3-${driver.capabilities().imageBuild}`, command: 'groups-restart', args: { id: 'ag-1' } },
        { caller: 'host' },
      );

      expect(resp.ok).toBe(true);
      expect((resp as OkResponse).data).toMatchObject({ restarted: 2, rebuilt: false });
      expect(buildAgentGroupImage).not.toHaveBeenCalled();
    }
  });
});
