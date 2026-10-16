/**
 * pr-factory-core guard — bootstrap's consumption of the core entity-model
 * writers against the REAL composed schema (instance substrate + pr-factory
 * migration both applied, which pins the recipe ordering: slack-bots before
 * pr-factory-core).
 *
 * Asserts the full bootstrap surface: worker agent group (default-instance
 * messaging group, mention-sticky/per-thread wiring, seeded default
 * instructions); supervisor agent group + two instance-scoped messaging
 * groups with their distinct wirings; tester messaging group auto-created
 * when the operator's pr-tester agent group exists; idempotent re-run;
 * foreign-wiring drop; engage-mode drift correction.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-prf-bootstrap/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-prf-bootstrap/groups',
  };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import {
  createMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  updateMessagingGroupAgent,
} from '../../db/messaging-groups.js';
import { SUPERVISOR_INSTANCE } from '../../channels/slack-supervisor.js';
import { TESTER_INSTANCE } from '../../channels/slack-tester.js';
import { bootstrapPrFactory, TESTER_FOLDER, WORKER_FOLDER } from './bootstrap.js';
import { SUPERVISOR_FOLDER } from './supervisor.js';

const TEST_DIR = '/tmp/nanoclaw-test-prf-bootstrap';
const WORKER_CHANNEL = 'C0WORK';
const SUPERVISOR_CHANNEL = 'C0ADMIN';
const WORKER_PLATFORM_ID = `slack:${WORKER_CHANNEL}`;

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('bootstrapPrFactory', () => {
  it('creates the worker agent group, default-instance messaging group, and mention-sticky/per-thread wiring', () => {
    const result = bootstrapPrFactory({ workerChannelId: WORKER_CHANNEL });

    const worker = getAgentGroupByFolder(WORKER_FOLDER);
    expect(worker).toBeDefined();
    expect(result.workerAgentGroupId).toBe(worker!.id);
    expect(result.workerPlatformId).toBe(WORKER_PLATFORM_ID);

    const mg = getMessagingGroupByPlatform('slack', WORKER_PLATFORM_ID, 'slack');
    expect(mg).toBeDefined();
    expect(result.workerMessagingGroupId).toBe(mg!.id);
    expect(mg!.instance).toBe('slack');

    const wirings = getMessagingGroupAgents(mg!.id);
    expect(wirings).toHaveLength(1);
    expect(wirings[0].agent_group_id).toBe(worker!.id);
    expect(wirings[0].engage_mode).toBe('mention-sticky');
    expect(wirings[0].session_mode).toBe('per-thread');
    expect(wirings[0].ignored_message_policy).toBe('drop');
  });

  it('seeds the worker group with the default triage instructions', () => {
    bootstrapPrFactory({ workerChannelId: WORKER_CHANNEL });

    // Default review/triage/test-plan workflow lands in the group's
    // CLAUDE.local.md — the operator override point.
    const claudeLocal = path.join(TEST_DIR, 'groups', WORKER_FOLDER, 'CLAUDE.local.md');
    const seeded = fs.readFileSync(claudeLocal, 'utf8');
    expect(seeded).toContain('# PR Factory Worker');
    expect(seeded).toContain('PR triage workflow');
    expect(seeded).toContain('send_to_testing');
  });

  it('creates the supervisor group plus its two instance-scoped messaging groups with distinct modes', () => {
    bootstrapPrFactory({ workerChannelId: WORKER_CHANNEL, supervisorChannelId: SUPERVISOR_CHANNEL });

    const supervisor = getAgentGroupByFolder(SUPERVISOR_FOLDER);
    expect(supervisor).toBeDefined();

    const adminMg = getMessagingGroupByPlatform('slack', `slack:${SUPERVISOR_CHANNEL}`, SUPERVISOR_INSTANCE);
    expect(adminMg).toBeDefined();
    const adminWiring = getMessagingGroupAgents(adminMg!.id)[0];
    expect(adminWiring.agent_group_id).toBe(supervisor!.id);
    expect(adminWiring.engage_mode).toBe('pattern');
    expect(adminWiring.session_mode).toBe('shared');

    const prMg = getMessagingGroupByPlatform('slack', WORKER_PLATFORM_ID, SUPERVISOR_INSTANCE);
    expect(prMg).toBeDefined();
    const prWiring = getMessagingGroupAgents(prMg!.id)[0];
    expect(prWiring.agent_group_id).toBe(supervisor!.id);
    expect(prWiring.engage_mode).toBe('mention');
    expect(prWiring.ignored_message_policy).toBe('accumulate');
    expect(prWiring.session_mode).toBe('per-thread');

    // The supervisor's PR-channel row never shadows the worker's
    // default-instance row.
    expect(getMessagingGroupByPlatform('slack', WORKER_PLATFORM_ID, 'slack')!.id).not.toBe(prMg!.id);
  });

  it('creates the tester messaging group + wiring when the operator-created pr-tester agent group exists', () => {
    // Without the tester agent group: no tester messaging group.
    bootstrapPrFactory({ workerChannelId: WORKER_CHANNEL });
    expect(getMessagingGroupByPlatform('slack', WORKER_PLATFORM_ID, TESTER_INSTANCE)).toBeUndefined();

    // Operator creates the tester agent group out of band, then bootstrap re-runs.
    createAgentGroup({
      id: 'ag-tester',
      name: 'PR Tester',
      folder: TESTER_FOLDER,
      agent_provider: null,
      created_at: now(),
    });
    bootstrapPrFactory({ workerChannelId: WORKER_CHANNEL });

    const testerMg = getMessagingGroupByPlatform('slack', WORKER_PLATFORM_ID, TESTER_INSTANCE);
    expect(testerMg).toBeDefined();
    const wiring = getMessagingGroupAgents(testerMg!.id)[0];
    expect(wiring.agent_group_id).toBe('ag-tester');
    expect(wiring.engage_mode).toBe('mention');
    expect(wiring.session_mode).toBe('per-thread');
  });

  it('is idempotent — a second run creates no duplicate rows', () => {
    createAgentGroup({
      id: 'ag-tester',
      name: 'PR Tester',
      folder: TESTER_FOLDER,
      agent_provider: null,
      created_at: now(),
    });
    const first = bootstrapPrFactory({ workerChannelId: WORKER_CHANNEL, supervisorChannelId: SUPERVISOR_CHANNEL });
    const second = bootstrapPrFactory({ workerChannelId: WORKER_CHANNEL, supervisorChannelId: SUPERVISOR_CHANNEL });

    expect(second.workerAgentGroupId).toBe(first.workerAgentGroupId);
    expect(second.workerMessagingGroupId).toBe(first.workerMessagingGroupId);

    for (const instance of ['slack', SUPERVISOR_INSTANCE, TESTER_INSTANCE]) {
      const mg = getMessagingGroupByPlatform('slack', WORKER_PLATFORM_ID, instance);
      expect(mg).toBeDefined();
      expect(getMessagingGroupAgents(mg!.id)).toHaveLength(1);
    }
  });

  it('drops pre-seeded foreign wirings on the PR channel', () => {
    const first = bootstrapPrFactory({ workerChannelId: WORKER_CHANNEL });

    // A legacy agent group still wired to the PR channel.
    createAgentGroup({
      id: 'ag-legacy',
      name: 'Legacy',
      folder: 'legacy-worker',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-legacy',
      messaging_group_id: first.workerMessagingGroupId,
      agent_group_id: 'ag-legacy',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
    expect(getMessagingGroupAgents(first.workerMessagingGroupId)).toHaveLength(2);

    bootstrapPrFactory({ workerChannelId: WORKER_CHANNEL });
    const wirings = getMessagingGroupAgents(first.workerMessagingGroupId);
    expect(wirings).toHaveLength(1);
    expect(wirings[0].agent_group_id).toBe(first.workerAgentGroupId);
  });

  it('self-corrects drifted wiring options instead of skipping them', () => {
    const first = bootstrapPrFactory({ workerChannelId: WORKER_CHANNEL });
    const [wiring] = getMessagingGroupAgents(first.workerMessagingGroupId);

    // Simulate an older bootstrap having written different modes.
    updateMessagingGroupAgent(wiring.id, { engage_mode: 'pattern', session_mode: 'shared' });

    bootstrapPrFactory({ workerChannelId: WORKER_CHANNEL });
    const [corrected] = getMessagingGroupAgents(first.workerMessagingGroupId);
    expect(corrected.id).toBe(wiring.id);
    expect(corrected.engage_mode).toBe('mention-sticky');
    expect(corrected.session_mode).toBe('per-thread');
  });
});
