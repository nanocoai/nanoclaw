/**
 * Synthetic-fixture coverage for the narrowly scoped Maintenance-group
 * transcript search. No real worker messages anywhere in this file.
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { searchMaintenanceTranscript } from './search.js';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-maintenance-transcript' };
});

const TEST_DIR = '/tmp/nanoclaw-test-maintenance-transcript';
const MC = 'ag-mc-test';
const OTHER = 'ag-other-test';

function now(): string {
  return new Date().toISOString();
}

async function seedChannelSession(agentGroupId: string, messagingGroupId: string, sessionId: string): Promise<Session> {
  await createMessagingGroup({
    id: messagingGroupId,
    channel_type: 'telegram',
    platform_id: `chat-${messagingGroupId}`,
    name: 'Synthetic Worker Group',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  const session: Session = {
    id: sessionId,
    agent_group_id: agentGroupId,
    messaging_group_id: messagingGroupId,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  await createSession(session);
  initSessionFolder(agentGroupId, sessionId);
  return session;
}

async function seedChatMessage(
  agentGroupId: string,
  sessionId: string,
  id: string,
  timestamp: string,
  sender: string,
  senderId: string,
  text: string,
  attachments?: Array<{ name: string; type: string; url?: string }>,
): Promise<void> {
  await writeSessionMessage(agentGroupId, sessionId, {
    id,
    kind: 'chat',
    timestamp,
    platformId: senderId,
    channelType: 'telegram',
    content: JSON.stringify({ text, sender, senderId, attachments }),
  });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: MC, name: 'MC', folder: 'mc', agent_provider: null, created_at: now() });
  await createAgentGroup({ id: OTHER, name: 'Other', folder: 'other', agent_provider: null, created_at: now() });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('searchMaintenanceTranscript', () => {
  it('fails closed when the agent group has no channel-bound session', async () => {
    const result = await searchMaintenanceTranscript({ agentGroupId: MC });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no active channel-bound session/);
  });

  it('fails closed when the agent group has more than one channel-bound session (ambiguous)', async () => {
    await seedChannelSession(MC, 'mg-1', 'sess-1');
    await seedChannelSession(MC, 'mg-2', 'sess-2');

    const result = await searchMaintenanceTranscript({ agentGroupId: MC });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ambiguous/);
  });

  it('returns sender, timestamp, text, and attachment metadata for the sole channel session', async () => {
    const session = await seedChannelSession(MC, 'mg-1', 'sess-1');
    await seedChatMessage(MC, session.id, 'm1', '2026-08-22T09:00:00.000Z', 'Ivan', 'telegram:2000', 'On my way to Maple St', [
      { name: 'photo.jpg', type: 'image', url: 'https://example.test/photo.jpg' },
    ]);

    const result = await searchMaintenanceTranscript({ agentGroupId: MC });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessionId).toBe(session.id);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      sender: 'Ivan',
      senderId: 'telegram:2000',
      text: 'On my way to Maple St',
    });
    expect(result.results[0].attachments).toEqual([{ name: 'photo.jpg', type: 'image', url: 'https://example.test/photo.jpg' }]);
  });

  it('filters by date range', async () => {
    const session = await seedChannelSession(MC, 'mg-1', 'sess-1');
    await seedChatMessage(MC, session.id, 'm1', '2026-08-20T09:00:00.000Z', 'Ivan', 'telegram:2000', 'old message');
    await seedChatMessage(MC, session.id, 'm2', '2026-08-22T09:00:00.000Z', 'Ivan', 'telegram:2000', 'in range message');

    const result = await searchMaintenanceTranscript({
      agentGroupId: MC,
      start: '2026-08-21T00:00:00.000Z',
      end: '2026-08-23T00:00:00.000Z',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results).toHaveLength(1);
      expect(result.results[0].text).toBe('in range message');
    }
  });

  it('filters by worker (substring match on sender name/id)', async () => {
    const session = await seedChannelSession(MC, 'mg-1', 'sess-1');
    await seedChatMessage(MC, session.id, 'm1', '2026-08-22T09:00:00.000Z', 'Ivan', 'telegram:2000', 'from Ivan');
    await seedChatMessage(MC, session.id, 'm2', '2026-08-22T09:05:00.000Z', 'Elehazar', 'telegram:3000', 'from Elehazar');

    const result = await searchMaintenanceTranscript({ agentGroupId: MC, worker: 'Elehazar' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results).toHaveLength(1);
      expect(result.results[0].text).toBe('from Elehazar');
    }
  });

  it('filters by keyword (substring match on text, case-insensitive)', async () => {
    const session = await seedChannelSession(MC, 'mg-1', 'sess-1');
    await seedChatMessage(MC, session.id, 'm1', '2026-08-22T09:00:00.000Z', 'Ivan', 'telegram:2000', 'the faucet is LEAKING badly');
    await seedChatMessage(MC, session.id, 'm2', '2026-08-22T09:05:00.000Z', 'Ivan', 'telegram:2000', 'all good here');

    const result = await searchMaintenanceTranscript({ agentGroupId: MC, keyword: 'leaking' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results).toHaveLength(1);
      expect(result.results[0].text).toMatch(/leaking/i);
    }
  });

  it("never exposes another agent group's session, even with the same-shaped call", async () => {
    const mcSession = await seedChannelSession(MC, 'mg-mc', 'sess-mc');
    await seedChatMessage(MC, mcSession.id, 'm1', '2026-08-22T09:00:00.000Z', 'Ivan', 'telegram:2000', 'MC group message');

    const otherSession = await seedChannelSession(OTHER, 'mg-other', 'sess-other');
    await seedChatMessage(OTHER, otherSession.id, 'm2', '2026-08-22T09:00:00.000Z', 'Someone', 'telegram:9999', 'unrelated group message');

    const result = await searchMaintenanceTranscript({ agentGroupId: MC });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessionId).toBe(mcSession.id);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].text).toBe('MC group message');
    }
  });

  it('never reads an A2A or task session (messaging_group_id null) as the target', async () => {
    // No channel-bound session exists for MC -- only a bare active session
    // with messaging_group_id null (shape of an A2A/task session) --
    // must still fail closed, not silently pick it.
    const session: Session = {
      id: 'sess-a2a-like',
      agent_group_id: MC,
      messaging_group_id: null,
      thread_id: 'system:a2a:ag-peer',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: now(),
      created_at: now(),
    };
    await createSession(session);
    initSessionFolder(MC, session.id);

    const result = await searchMaintenanceTranscript({ agentGroupId: MC });
    expect(result.ok).toBe(false);
  });
});
