/**
 * `ncl templates list` — scope reachability and the registry-listing contract
 * (bounded output, category filter, local marking, never a version).
 *
 * Drives the real dispatcher so the group-scope decision under test is the one
 * production takes; only the registry module and the container-config lookup
 * that feeds cli_scope are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cliScope: 'group' as 'group' | 'global' | 'disabled',
  fetchRegistryIndex: vi.fn(),
  listLocalTemplates: vi.fn(),
  hasLocalTemplate: vi.fn(),
}));

vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: vi.fn(async () => ({ cli_scope: mocks.cliScope })),
}));

vi.mock('../../templates/registry.js', () => ({
  fetchRegistryIndex: mocks.fetchRegistryIndex,
  listLocalTemplates: mocks.listLocalTemplates,
  hasLocalTemplate: mocks.hasLocalTemplate,
}));

import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `templates-list` command.
import './templates.js';

const AGENT_CTX = {
  caller: 'agent' as const,
  sessionId: 'sess-1',
  agentGroupId: 'ag-1',
  messagingGroupId: 'mg-1',
};

function listFrame(args: Record<string, unknown> = {}) {
  return { id: 'req-1', command: 'templates-list', args };
}

function registryIndex(count: number) {
  return {
    schema: 1 as const,
    templates: Array.from({ length: count }, (_, i) => ({
      ref: `sales/tpl-${i}`,
      name: `tpl-${i}`,
      version: '1.2.3',
      description: `desc ${i}`,
    })),
  };
}

beforeEach(() => {
  mocks.cliScope = 'group';
  vi.clearAllMocks();
  mocks.listLocalTemplates.mockReturnValue([{ ref: 'sales/sdr', name: 'sdr', description: 'Outbound SDR' }]);
  mocks.hasLocalTemplate.mockReturnValue(false);
  mocks.fetchRegistryIndex.mockResolvedValue(registryIndex(30));
});

describe('templates list', () => {
  it('is reachable for a group-scoped agent', async () => {
    const resp = await dispatch(listFrame(), AGENT_CTX);

    expect(resp.ok).toBe(true);
    expect(resp.ok && resp.data).toEqual([
      { ref: 'sales/sdr', name: 'sdr', description: 'Outbound SDR', source: 'local' },
    ]);
  });

  it('is denied when cli_scope is disabled', async () => {
    mocks.cliScope = 'disabled';

    const resp = await dispatch(listFrame(), AGENT_CTX);

    expect(resp.ok).toBe(false);
    expect(resp.ok === false && resp.error.code).toBe('forbidden');
  });

  it('never touches the registry for a local listing', async () => {
    await dispatch(listFrame(), AGENT_CTX);

    expect(mocks.fetchRegistryIndex).not.toHaveBeenCalled();
  });

  it('rejects --category or --limit without --registry', async () => {
    for (const args of [{ category: 'sales' }, { limit: 5 }]) {
      const resp = await dispatch(listFrame(args), AGENT_CTX);
      expect(resp.ok).toBe(false);
      expect(resp.ok === false && resp.error.message).toContain('require --registry');
    }
  });

  it('filters the registry by --category', async () => {
    mocks.fetchRegistryIndex.mockResolvedValue({
      schema: 1,
      templates: [
        { ref: 'sales/sdr', name: 'sdr', version: '1.0.0', description: 'Outbound SDR' },
        { ref: 'data/analyst', name: 'analyst', version: '1.0.0', description: 'Analyst' },
      ],
    });

    const resp = await dispatch(listFrame({ registry: true, category: 'sales' }), AGENT_CTX);

    expect(resp.ok && (resp.data as Array<{ ref: string }>).map((r) => r.ref)).toEqual(['sales/sdr']);
  });

  it('bounds registry output at the default limit and clamps --limit to the max', async () => {
    const capped = await dispatch(listFrame({ registry: true }), AGENT_CTX);
    expect(capped.ok && (capped.data as unknown[]).length).toBe(20);

    mocks.fetchRegistryIndex.mockResolvedValue(registryIndex(150));
    const clamped = await dispatch(listFrame({ registry: true, limit: 500 }), AGENT_CTX);
    expect(clamped.ok && (clamped.data as unknown[]).length).toBe(100);
  });

  it('marks refs with a local copy and carries no version', async () => {
    mocks.fetchRegistryIndex.mockResolvedValue(registryIndex(2));
    mocks.hasLocalTemplate.mockImplementation((ref: string) => ref === 'sales/tpl-0');

    const resp = await dispatch(listFrame({ registry: true }), AGENT_CTX);

    expect(resp.ok && resp.data).toEqual([
      { ref: 'sales/tpl-0', name: 'tpl-0', description: 'desc 0', local: true },
      { ref: 'sales/tpl-1', name: 'tpl-1', description: 'desc 1', local: false },
    ]);
    expect(resp.ok && resp.human).toContain('sales/tpl-0 [local] - desc 0');
  });
});
