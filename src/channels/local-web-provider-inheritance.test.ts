import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: '/tmp/nanoclaw-test-local-web-provider-inheritance' }));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    DATA_DIR: path.join(TEST_ROOT, 'data'),
    GROUPS_DIR: path.join(TEST_ROOT, 'groups'),
    DEFAULT_AGENT_PROVIDER: 'claude',
  };
});

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../modules/agent-to-agent/write-destinations.js', () => ({ writeDestinations: vi.fn() }));

import { materializeContainerJson } from '../container-config.js';
import { DEFAULT_AGENT_PROVIDER } from '../config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../db/agent-groups.js';
import { getContainerConfig, updateContainerConfigScalars } from '../db/container-configs.js';
import { closeDb, initTestDb } from '../db/connection.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../db/messaging-groups.js';
import { runMigrations } from '../db/migrations/index.js';
import { initGroupFilesystem } from '../group-init.js';
import {
  getProviderContainerConfig,
  registerProviderContainerConfig,
} from '../providers/provider-container-registry.js';
import '../cli/resources/groups.js';
import '../cli/resources/messaging-groups.js';
import '../cli/resources/wirings.js';
import './local-web.js';
import { createLocalWebAgent, listLocalWebCatalog } from './local-web-conversations.js';

if (!getProviderContainerConfig('ollama')) registerProviderContainerConfig('ollama', () => ({}));

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
  const source = {
    id: 'ag-ollama',
    name: 'Ollama',
    folder: 'ollama',
    agent_provider: null,
    created_at: new Date().toISOString(),
  };
  await createAgentGroup(source);
  await initGroupFilesystem(source, { provider: 'ollama' });
  await updateContainerConfigScalars(source.id, { provider: 'ollama', model: 'qwen3.8:27b-mlx' });
  await createMessagingGroup({
    id: 'mg-ollama',
    channel_type: 'local-web',
    platform_id: 'local-web:local',
    name: 'Ollama',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: new Date().toISOString(),
  });
  await createMessagingGroupAgent({
    id: 'mga-ollama',
    messaging_group_id: 'mg-ollama',
    agent_group_id: source.id,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: new Date().toISOString(),
  });
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('local web provider inheritance', () => {
  it('inherits selected Ollama runtime without changing installation defaults', async () => {
    expect(await listLocalWebCatalog()).toMatchObject({
      installedProviders: expect.arrayContaining(['claude', 'ollama']),
      installationDefault: 'claude',
      isInstallationDefaultInstalled: true,
    });
    const result = await createLocalWebAgent({ name: 'Researcher', sourceConversationId: 'mg-ollama' });
    expect(result).toMatchObject({
      ok: true,
      created: true,
      conversation: { provider: 'ollama', model: 'qwen3.8:27b-mlx' },
    });
    const group = await getAgentGroupByFolder('web-researcher');
    expect(group).toBeDefined();
    expect(await getContainerConfig(group!.id)).toMatchObject({ provider: 'ollama', model: 'qwen3.8:27b-mlx' });
    expect(await materializeContainerJson(group!.id)).toMatchObject({ provider: 'ollama', model: 'qwen3.8:27b-mlx' });
    expect(DEFAULT_AGENT_PROVIDER).toBe('claude');
  });
});
