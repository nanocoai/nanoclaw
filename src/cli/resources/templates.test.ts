import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-cli-templates';

vi.mock('../../config.js', async () => ({
  ...(await vi.importActual<typeof import('../../config.js')>('../../config.js')),
  DATA_DIR: '/tmp/nanoclaw-test-cli-templates',
  TEMPLATES_DIR: '/tmp/nanoclaw-test-cli-templates/templates',
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { updateContainerConfigScalars, ensureContainerConfig } from '../../db/container-configs.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import { _forgetLibraryIndex } from './templates.js';

const agent: CallerContext = { caller: 'agent', agentGroupId: 'ag-1', sessionId: 'chat-1', messagingGroupId: 'mg-1' };

function writeTemplate(ref: string, description: string): void {
  const dir = path.join(TEST_DIR, 'templates', ref);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: ref.split('/').pop(),
      description,
    }),
  );
}

beforeEach(async () => {
  _forgetLibraryIndex();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: 'ag-1',
    name: 'ag-1',
    folder: 'ag-1',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('ncl templates list', () => {
  it('lists the templates on this machine for a group-scoped agent, without the network', async () => {
    writeTemplate('sales/sdr', 'Books meetings');
    writeTemplate('_drafts/x', 'Not a ref create_agent accepts');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const resp = await dispatch({ id: '1', command: 'templates-list', args: {} }, agent);

    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data).toEqual([{ ref: 'sales/sdr', name: 'sdr', description: 'Books meetings' }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('--registry lists the public library and marks what is already here', async () => {
    writeTemplate('sales/sdr', 'Books meetings');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          schema: 1,
          categories: {
            sales: [{ ref: 'sales/sdr', name: 'sdr', version: '1.0.0', description: 'Books meetings' }],
            data: [{ ref: 'data/analyst', name: 'analyst', version: '1.0.0', description: 'Checks pipelines' }],
          },
        }),
      ),
    );

    const resp = await dispatch({ id: '2', command: 'templates-list', args: { registry: true } }, agent);

    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data).toEqual([
      { ref: 'data/analyst', name: 'analyst', description: 'Checks pipelines', local: false },
      { ref: 'sales/sdr', name: 'sdr', description: 'Books meetings', local: true },
    ]);
  });

  it('reuses a fetched library index for later listings', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ schema: 1, categories: {} })));

    await dispatch({ id: 'a', command: 'templates-list', args: { registry: true } }, agent);
    await dispatch({ id: 'b', command: 'templates-list', args: { registry: true } }, agent);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('fetches the library index once for a burst of listings, failures included', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('blackholed'));

    const results = await Promise.all(
      [1, 2, 3].map((n) => dispatch({ id: `r${n}`, command: 'templates-list', args: { registry: true } }, agent)),
    );
    const again = await dispatch({ id: 'r4', command: 'templates-list', args: { registry: true } }, agent);

    expect([...results, again].every((r) => !r.ok)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('is closed to an agent whose CLI access is disabled', async () => {
    await ensureContainerConfig('ag-1');
    await updateContainerConfigScalars('ag-1', { cli_scope: 'disabled' });

    const resp = await dispatch({ id: '3', command: 'templates-list', args: {} }, agent);

    expect(resp.ok).toBe(false);
  });
});
