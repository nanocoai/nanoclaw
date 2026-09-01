/**
 * Wiring tests for the in-process workspace controller.
 *
 * These drive the REAL entry points rather than the module's own functions, so
 * they go red when the integration is deleted or drifts — a direct unit test of
 * `useLocalWorkspaceController` would stay green with the barrel import gone,
 * which is exactly the regression worth catching.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ensureWorkspace,
  localWorkspaceControllerInstalled,
  useLocalWorkspaceController,
  type WorkspaceAssignment,
} from './workspace-plane.js';

afterEach(() => useLocalWorkspaceController(null));

const HOST_ROOT = '/var/lib/nanoco/workspaces';
const assignment = (groupId: string, sessionId: string): WorkspaceAssignment => ({
  groupId,
  sessionId,
  runtimeTier: 'vm',
  nodeName: 'node-1',
  generation: 7,
  plainHostPath: path.posix.join(HOST_ROOT, groupId, 'generations', '7', 'plain'),
});

describe('the workspace plane runs in-process', () => {
  it('routes ensure to the local controller instead of the network', async () => {
    const groupId = 'd9cf1e39-bce5-4d1b-801b-a60c82bdcb8c';
    const sessionId = 'sess-1';
    const ensure = vi.fn(async () => assignment(groupId, sessionId));
    // No controller URL and no token file: the HTTP transport cannot satisfy
    // this call, so a pass proves the in-process path carried it.
    useLocalWorkspaceController({ ensure, release: vi.fn(), ensurePaths: vi.fn() } as never);

    const result = await ensureWorkspace(
      { groupId, sessionId, runtimeTier: 'vm' },
      { NANOCO_WORKSPACE_HOST_ROOT: HOST_ROOT } as NodeJS.ProcessEnv,
    );

    expect(ensure).toHaveBeenCalledOnce();
    expect(result.generation).toBe(7);
  });

  it('falls back to the HTTP transport when no local controller is installed', async () => {
    expect(localWorkspaceControllerInstalled()).toBe(false);
    // The remote seam must still be reachable for a split deployment — proven
    // by the transport's own configuration refusal, not by a network call.
    await expect(
      ensureWorkspace(
        { groupId: 'g', sessionId: 's', runtimeTier: 'vm' },
        { NANOCO_WORKSPACE_HOST_ROOT: HOST_ROOT } as NodeJS.ProcessEnv,
      ),
    ).rejects.toThrow(/NANOCO_WORKSPACE_CONTROLLER_URL/);
  });
});

describe('the module is wired into host startup', () => {
  const barrel = path.join(process.cwd(), 'src', 'modules', 'index.ts');

  it('is imported by the modules barrel, so it self-registers on boot', () => {
    // Red when the nc:append reach-in is removed: the module would never be
    // imported, nothing would register on host start, and every ensure would
    // silently fall back to an HTTP hop that this deployment does not run.
    expect(fs.existsSync(barrel)).toBe(true);
    expect(fs.readFileSync(barrel, 'utf8')).toContain('storage/workspace-controller-module.js');
  });

  it('registers on host start and detaches on host shutdown', async () => {
    const lifecycle = await import('../host-lifecycle.js');
    await import('./workspace-controller-module.js');
    // Registration is inert at import time — the callbacks exist, and the
    // plane stays on its HTTP transport until the host actually starts.
    expect(lifecycle.getHostStartCallbacks().length).toBeGreaterThan(0);
    expect(lifecycle.getHostShutdownCallbacks().length).toBeGreaterThan(0);
    expect(localWorkspaceControllerInstalled()).toBe(false);
  });
});
