/**
 * A parked-app resume through the REAL guard-wrapped create_agent entry, over
 * a real in-memory central DB, mocking the Slack leg, the approval card and
 * session I/O. A resume reuses its agent, so upstream's folder precheck must
 * not refuse it: on an install migrated from v1 an agent named "Global" lives
 * under global-2, and asking for it again finishes its parked app. A new name
 * that can't be a folder is still refused before any card, and whether another
 * group holds a folder never changes the answer before approval. Upstream
 * wording is matched loosely: this file also runs in installs' later update
 * validations. rootDir is process.cwd(), so each test runs chdir'd into its
 * own tmpdir.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';

const { mockNotifyWrite, mockRequestApproval, mockRunSlackAgentFlow } = vi.hoisted(() => ({
  mockNotifyWrite: vi.fn(),
  mockRequestApproval: vi.fn().mockResolvedValue(undefined),
  mockRunSlackAgentFlow: vi.fn().mockResolvedValue({ roomChannelId: 'G0ROOM' }),
}));

vi.mock('./orchestrate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./orchestrate.js')>()),
  runSlackAgentFlow: (...a: unknown[]) => mockRunSlackAgentFlow(...a),
}));
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...a: unknown[]) => mockNotifyWrite(...a),
  openInboundDb: vi.fn(),
  openOutboundDb: vi.fn(),
  clearOutbox: vi.fn(),
  readOutboxFiles: vi.fn().mockReturnValue([]),
  resolveSession: vi.fn(),
  sessionDir: vi.fn().mockReturnValue('/tmp/nowhere'),
  inboundDbPath: vi.fn().mockReturnValue('/tmp/nowhere/inbound.db'),
}));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));
vi.mock('../approvals/index.js', async () => {
  const primitive = await vi.importActual<typeof import('../approvals/primitive.js')>('../approvals/primitive.js');
  return {
    requestApproval: (...a: unknown[]) => mockRequestApproval(...a),
    notifyAgent: primitive.notifyAgent,
    registerApprovalHandler: vi.fn(),
  };
});

import './index.js';
import { getDeliveryAction } from '../../delivery.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup, getAllAgentGroups } from '../../db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession } from '../../db/sessions.js';
import { createDestination } from '../agent-to-agent/db/agent-destinations.js';

const SESSION: Session = {
  id: 'sess-1',
  agent_group_id: 'ag-src',
  messaging_group_id: 'mg-origin',
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-01-01T00:00:00.000Z',
};
const originalCwd = process.cwd();
let tmpDir = '';

function notifyTexts(): string[] {
  return mockNotifyWrite.mock.calls.map((c) => JSON.parse((c[2] as { content: string }).content).text as string);
}

async function request(cliScope: 'global' | 'group', name = 'Global'): Promise<void> {
  await updateContainerConfigScalars('ag-src', { cli_scope: cliScope });
  await getDeliveryAction('create_agent')!({ action: 'create_agent', name }, SESSION);
}

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-create-agent-resume-'));
  process.chdir(tmpDir);
  // The app exists and the workspace never approved it: app token and id, no bot token.
  fs.writeFileSync(path.join(tmpDir, '.env'), 'SLACK_APP_TOKEN_GLOBAL=xapp-test\nSLACK_APP_ID_GLOBAL=A0PARKED\n');

  await runMigrations(await initTestDb());
  const now = new Date().toISOString();
  await createAgentGroup({ id: 'ag-src', name: 'Andy', folder: 'andy', agent_provider: null, created_at: now });
  await ensureContainerConfig('ag-src');
  await createAgentGroup({
    id: 'ag-global',
    name: 'Global',
    folder: 'global-2',
    agent_provider: null,
    created_at: now,
  });
  await createDestination({
    agent_group_id: 'ag-src',
    local_name: 'global',
    target_type: 'agent',
    target_id: 'ag-global',
    created_at: now,
  });
  await createMessagingGroup({
    id: 'mg-origin',
    channel_type: 'slack',
    platform_id: 'slack:D0OPDM',
    name: 'Op DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await createSession(SESSION);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('create_agent — parked Slack app resume', () => {
  it('resumes the parked "Global" stored under global-2 instead of refusing its folder', async () => {
    await request('global');

    expect(mockRunSlackAgentFlow).toHaveBeenCalledTimes(1);
    expect(mockRunSlackAgentFlow.mock.calls[0][0]).toMatchObject({ newAgentGroupId: 'ag-global', slug: 'global' });
    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(await getAllAgentGroups()).toHaveLength(2);
    expect(notifyTexts().join('\n')).not.toContain('Invalid group folder');
  });

  it('still holds a group-scope resume for the admin', async () => {
    await request('group');

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockRunSlackAgentFlow).not.toHaveBeenCalled();
    expect(notifyTexts()).toEqual([]);
  });

  it('without a parked app, answers the repeat "Global" as taken', async () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), '');

    await request('global');

    expect(mockRunSlackAgentFlow).not.toHaveBeenCalled();
    expect(notifyTexts()).toHaveLength(1);
    expect(notifyTexts()[0]).toContain('already have a destination');
    expect(await getAllAgentGroups()).toHaveLength(2);
  });

  it('refuses a new name that cannot be a folder before any card', async () => {
    await request('group', 'Global Two'.padEnd(70, 'x'));

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockRunSlackAgentFlow).not.toHaveBeenCalled();
    expect(notifyTexts()[0]).toContain('Invalid group folder');
  });

  it('gives a taken and a free name the same card', async () => {
    const name = 'b'.repeat(62);
    await request('group', name);
    await createAgentGroup({
      id: 'ag-other',
      name: 'Other',
      folder: name,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await request('group', name);

    expect(mockRequestApproval).toHaveBeenCalledTimes(2);
    expect(notifyTexts()).toEqual([]);
  });
});
