import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createSession,
  findSession,
  findSessionByAgentGroup,
  findTemporalSession,
  getActiveSessions,
  initTestDb,
  runMigrations,
} from './index.js';
import { findSessionForAgent } from './sessions.js';

function now() {
  return new Date().toISOString();
}

describe('temporal sessions', () => {
  const ag = `ag-${randomUUID()}`;
  const mg = `mg-${randomUUID()}`;

  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: ag,
      name: 'Agent',
      folder: `folder-${randomUUID()}`,
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: mg,
      channel_type: 'discord',
      platform_id: `chan-${randomUUID()}`,
      name: 'DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
  });

  afterEach(() => {
    closeDb();
  });

  const baseSess = () => ({
    agent_group_id: ag,
    messaging_group_id: mg,
    thread_id: null,
    agent_provider: null,
    status: 'active' as const,
    container_status: 'stopped' as const,
    last_active: null,
    created_at: now(),
  });

  it('normal and temporal sessions coexist for the same (group, mg, thread)', () => {
    const normalId = `sess-${randomUUID()}`;
    const tempId = `sess-${randomUUID()}`;
    createSession({ ...baseSess(), id: normalId, temporal: 0 });
    createSession({ ...baseSess(), id: tempId, temporal: 1 });

    expect(getActiveSessions()).toHaveLength(2);
  });

  it('findSessionForAgent returns only the normal session', () => {
    const normalId = `sess-${randomUUID()}`;
    createSession({ ...baseSess(), id: normalId, temporal: 0 });
    createSession({ ...baseSess(), id: `sess-${randomUUID()}`, temporal: 1 });

    const found = findSessionForAgent(ag, mg, null);
    expect(found?.id).toBe(normalId);
    expect(found?.temporal).toBe(0);
  });

  it('findTemporalSession returns only the temporal session', () => {
    const tempId = `sess-${randomUUID()}`;
    createSession({ ...baseSess(), id: `sess-${randomUUID()}`, temporal: 0 });
    createSession({ ...baseSess(), id: tempId, temporal: 1 });

    const found = findTemporalSession(ag, mg, null);
    expect(found?.id).toBe(tempId);
    expect(found?.temporal).toBe(1);
  });

  it('temporal + normal coexist on a real thread id (not just DM null)', () => {
    const thread = `thread-${randomUUID()}`;
    const normalId = `sess-${randomUUID()}`;
    const tempId = `sess-${randomUUID()}`;
    createSession({ ...baseSess(), id: normalId, thread_id: thread, temporal: 0 });
    createSession({ ...baseSess(), id: tempId, thread_id: thread, temporal: 1 });

    expect(findSessionForAgent(ag, mg, thread)?.id).toBe(normalId);
    expect(findTemporalSession(ag, mg, thread)?.id).toBe(tempId);
  });

  it('findSession (messaging-group scoped) excludes temporal sessions', () => {
    createSession({ ...baseSess(), id: `sess-${randomUUID()}`, temporal: 1 });
    expect(findSession(mg, null)).toBeUndefined();

    const normalId = `sess-${randomUUID()}`;
    createSession({ ...baseSess(), id: normalId, temporal: 0 });
    expect(findSession(mg, null)?.id).toBe(normalId);
  });

  it('findSessionByAgentGroup excludes temporal sessions', () => {
    createSession({ ...baseSess(), id: `sess-${randomUUID()}`, temporal: 1 });
    expect(findSessionByAgentGroup(ag)).toBeUndefined();

    const normalId = `sess-${randomUUID()}`;
    createSession({ ...baseSess(), id: normalId, temporal: 0 });
    expect(findSessionByAgentGroup(ag)?.id).toBe(normalId);
  });

  it('createSession defaults temporal to 0 when omitted', () => {
    const id = `sess-${randomUUID()}`;
    createSession({ ...baseSess(), id });
    expect(findSessionForAgent(ag, mg, null)?.id).toBe(id);
    expect(findTemporalSession(ag, mg, null)).toBeUndefined();
  });
});
