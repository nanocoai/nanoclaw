import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: '/tmp/nanoclaw-test-local-web-default-provider' }));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    DATA_DIR: path.join(TEST_ROOT, 'data'),
    GROUPS_DIR: path.join(TEST_ROOT, 'groups'),
    DEFAULT_AGENT_PROVIDER: 'missing-provider',
  };
});

import { getAgentGroupByFolder } from '../db/agent-groups.js';
import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createLocalWebAgent, listLocalWebCatalog } from './local-web-conversations.js';

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('local web installation default mismatch', () => {
  it('exposes the mismatch and requires an installed provider choice', async () => {
    expect(await listLocalWebCatalog()).toMatchObject({
      installedProviders: expect.arrayContaining(['claude']),
      installationDefault: 'missing-provider',
      isInstallationDefaultInstalled: false,
    });
    expect(await createLocalWebAgent({ name: 'Writer' })).toMatchObject({
      ok: false,
      reason: 'provider_not_installed',
      message: expect.stringContaining('missing-provider'),
    });
    expect(await getAgentGroupByFolder('web-writer')).toBeUndefined();
  });
});
