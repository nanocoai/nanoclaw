/**
 * Self-mod guard × driver capabilities.
 *
 * install_packages ends in an image rebuild, and a runtime that declares
 * `imageBuild: false` cannot run one — so the request must be DENIED at
 * request time (no card is ever minted for an admin to approve), and an
 * approval issued under a capable driver must not execute after a switch
 * to an incapable one (a grant satisfies a hold, never a deny).
 *
 * The gate reads `capabilities()`, never the driver's kind. Only the Docker
 * driver ships in this tree, so the incapable polarity is a stub declaring
 * what an out-of-tree driver (no build daemon on the node) actually declares.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { DockerSessionDriver } from '../../drivers/docker-driver.js';
import { resetSessionDriver } from '../../drivers/index.js';
import { FIXTURE_POLICY } from '../../drivers/spec-fixture.js';
import type { SessionDriver } from '../../drivers/types.js';
import { guard } from '../../guard/index.js';
import type { PendingApproval } from '../../types.js';
import { selfModAddMcpServer, selfModInstallPackages } from './guard.js';

const agent = { kind: 'agent', agentGroupId: 'g1', sessionId: 's1' } as const;

function withDocker(): void {
  resetSessionDriver(new DockerSessionDriver(FIXTURE_POLICY));
}
function withoutImageBuild(): void {
  const docker = new DockerSessionDriver(FIXTURE_POLICY);
  resetSessionDriver({
    kind: docker.kind,
    capabilities: () => ({ ...docker.capabilities(), imageBuild: false }),
    prepare: () => Promise.reject(new Error('not under test')),
    listSessions: () => Promise.resolve([]),
    watchSessions: () => ({ stop: () => {} }),
  } satisfies SessionDriver);
}

afterEach(() => resetSessionDriver(null));

describe('install_packages gates on the imageBuild capability', () => {
  it('holds for admin approval on a driver that declares imageBuild (docker)', async () => {
    withDocker();
    const decision = await guard(selfModInstallPackages, { actor: agent, payload: { apt: ['jq'] } });
    expect(decision.effect).toBe('hold');
  });

  it('DENIES at request time on a driver without imageBuild, naming the capability', async () => {
    withoutImageBuild();
    const decision = await guard(selfModInstallPackages, { actor: agent, payload: { apt: ['jq'] } });
    expect(decision.effect).toBe('deny');
    // The refusal must name the capability so the agent can explain the
    // refusal instead of retrying a permanent condition.
    expect(decision.reason).toContain('imageBuild');
  });

  it('an approved replay cannot resurrect it — a grant satisfies a hold, never a deny', async () => {
    withoutImageBuild();
    // The scenario the gate exists for: approved while the group ran on a
    // capable driver, replayed after the driver switch. The deny
    // short-circuits before any grant validation, so no DB is consulted and
    // nothing runs.
    const grant = { approval_id: 'appr-1', action: 'install_packages', payload: '{}' } as unknown as PendingApproval;
    const decision = await guard(selfModInstallPackages, { actor: agent, payload: { apt: ['jq'] }, grant });
    expect(decision.effect).toBe('deny');
  });

  it('still refuses non-agent callers on a capable driver', async () => {
    withDocker();
    const decision = await guard(selfModInstallPackages, { actor: { kind: 'host' }, payload: {} });
    expect(decision.effect).toBe('deny');
  });
});

describe('add_mcp_server needs no rebuild and must not inherit the gate', () => {
  it('still holds on a driver without imageBuild', async () => {
    withoutImageBuild();
    // Wiring an MCP server is a DB write + container kill; the next wake
    // realizes it with no image change. Gating it on imageBuild would
    // silently strip a real capability from every group on such a driver.
    const decision = await guard(selfModAddMcpServer, { actor: agent, payload: { name: 'srv' } });
    expect(decision.effect).toBe('hold');
  });
});
