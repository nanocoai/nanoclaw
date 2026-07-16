import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockWriteOutboundDirect = vi.fn();
vi.mock('../../session-manager.js', () => ({
  writeOutboundDirect: (...args: unknown[]) => mockWriteOutboundDirect(...args),
}));

const mockEnterFallback = vi.fn();
const mockExitFallback = vi.fn();
vi.mock('./controller.js', () => ({
  enterFallback: (...args: unknown[]) => mockEnterFallback(...args),
  exitFallback: (...args: unknown[]) => mockExitFallback(...args),
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import type { Session } from '../../types.js';
import { enterFallbackState } from './db.js';
import { interceptFallbackCommand } from './commands.js';

const AGENT_GROUP_ID = 'group-1';
const OTHER_GROUP_ID = 'group-2';
const OWNER_ID = 'telegram:owner';
const ADMIN_ID = 'telegram:scoped-admin';
const PLAIN_USER_ID = 'telegram:plain';

const deliveryAddr = { channelType: 'telegram', platformId: 'chat-1', threadId: null };

function makeSession(agentGroupId: string): Session {
  return {
    id: 'sess-1',
    agent_group_id: agentGroupId,
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: 'claude',
    status: 'active',
    container_status: 'running',
    last_active: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };
}

function chatContent(text: string): string {
  return JSON.stringify({ text });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  vi.clearAllMocks();

  createAgentGroup({
    id: AGENT_GROUP_ID,
    name: 'Group 1',
    folder: 'group-1',
    agent_provider: 'claude',
    created_at: new Date().toISOString(),
  });
  createAgentGroup({
    id: OTHER_GROUP_ID,
    name: 'Group 2',
    folder: 'group-2',
    agent_provider: 'claude',
    created_at: new Date().toISOString(),
  });

  createUser({ id: OWNER_ID, kind: 'user', display_name: 'Owner', created_at: new Date().toISOString() });
  createUser({ id: ADMIN_ID, kind: 'user', display_name: 'Admin', created_at: new Date().toISOString() });
  createUser({ id: PLAIN_USER_ID, kind: 'user', display_name: 'Plain', created_at: new Date().toISOString() });

  grantRole({
    user_id: OWNER_ID,
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: new Date().toISOString(),
  });
  grantRole({
    user_id: ADMIN_ID,
    role: 'admin',
    agent_group_id: AGENT_GROUP_ID,
    granted_by: OWNER_ID,
    granted_at: new Date().toISOString(),
  });
});

afterEach(() => {
  closeDb();
});

describe('interceptFallbackCommand — not a fallback command', () => {
  it('returns false and does nothing for unrelated chat content', async () => {
    const handled = await interceptFallbackCommand(
      chatContent('ciao'),
      OWNER_ID,
      makeSession(AGENT_GROUP_ID),
      deliveryAddr,
    );
    expect(handled).toBe(false);
    expect(mockWriteOutboundDirect).not.toHaveBeenCalled();
  });
});

describe('interceptFallbackCommand — auth gating', () => {
  it('denies a plain member and replies with the denial notice', async () => {
    const handled = await interceptFallbackCommand(
      chatContent('/fallback status'),
      PLAIN_USER_ID,
      makeSession(AGENT_GROUP_ID),
      deliveryAddr,
    );
    expect(handled).toBe(true);
    expect(mockWriteOutboundDirect).toHaveBeenCalledTimes(1);
    const [, , payload] = mockWriteOutboundDirect.mock.calls[0];
    expect(JSON.parse(payload.content).text).toMatch(/owner|admin|fallback commands/i);
    expect(mockEnterFallback).not.toHaveBeenCalled();
  });

  it('denies a scoped admin acting on a different agent group', async () => {
    const handled = await interceptFallbackCommand(
      chatContent('/fallback status'),
      ADMIN_ID,
      makeSession(OTHER_GROUP_ID),
      deliveryAddr,
    );
    expect(handled).toBe(true);
    expect(mockEnterFallback).not.toHaveBeenCalled();
  });

  it('allows a scoped admin acting on their own agent group', async () => {
    const handled = await interceptFallbackCommand(
      chatContent('/fallback status'),
      ADMIN_ID,
      makeSession(AGENT_GROUP_ID),
      deliveryAddr,
    );
    expect(handled).toBe(true);
    expect(mockWriteOutboundDirect).toHaveBeenCalledTimes(1);
  });

  it('allows the global owner regardless of agent group', async () => {
    const handled = await interceptFallbackCommand(
      chatContent('/fallback status'),
      OWNER_ID,
      makeSession(OTHER_GROUP_ID),
      deliveryAddr,
    );
    expect(handled).toBe(true);
    expect(mockWriteOutboundDirect).toHaveBeenCalledTimes(1);
  });

  it('denies when there is no userId', async () => {
    const handled = await interceptFallbackCommand(
      chatContent('/fallback force'),
      null,
      makeSession(AGENT_GROUP_ID),
      deliveryAddr,
    );
    expect(handled).toBe(true);
    expect(mockEnterFallback).not.toHaveBeenCalled();
  });
});

describe('interceptFallbackCommand — subcommand parsing', () => {
  it('treats bare /fallback as status', async () => {
    await interceptFallbackCommand(chatContent('/fallback'), OWNER_ID, makeSession(AGENT_GROUP_ID), deliveryAddr);
    expect(mockWriteOutboundDirect).toHaveBeenCalledTimes(1);
    expect(mockEnterFallback).not.toHaveBeenCalled();
    expect(mockExitFallback).not.toHaveBeenCalled();
  });

  it('treats an unrecognized argument as status rather than leaking to the agent', async () => {
    const handled = await interceptFallbackCommand(
      chatContent('/fallback bogus'),
      OWNER_ID,
      makeSession(AGENT_GROUP_ID),
      deliveryAddr,
    );
    expect(handled).toBe(true);
    expect(mockWriteOutboundDirect).toHaveBeenCalledTimes(1);
  });

  it('is case-insensitive on both command and subcommand', async () => {
    await interceptFallbackCommand(chatContent('/FALLBACK FORCE'), OWNER_ID, makeSession(AGENT_GROUP_ID), deliveryAddr);
    expect(mockEnterFallback).toHaveBeenCalledTimes(1);
  });
});

describe('interceptFallbackCommand — force', () => {
  it('calls enterFallback with forced/manual bookkeeping tied to the current session', async () => {
    const session = makeSession(AGENT_GROUP_ID);
    await interceptFallbackCommand(chatContent('/fallback force'), OWNER_ID, session, deliveryAddr);

    expect(mockEnterFallback).toHaveBeenCalledTimes(1);
    const arg = mockEnterFallback.mock.calls[0][0];
    expect(arg.mode).toBe('forced');
    expect(arg.classification).toBe('manual');
    expect(arg.originSessionId).toBe(session.id);
    expect(arg.originGroupId).toBe(session.agent_group_id);
  });
});

describe('interceptFallbackCommand — return', () => {
  it('does not call exitFallback when fallback is not active, and replies with status instead', async () => {
    const handled = await interceptFallbackCommand(
      chatContent('/fallback return'),
      OWNER_ID,
      makeSession(AGENT_GROUP_ID),
      deliveryAddr,
    );
    expect(handled).toBe(true);
    expect(mockExitFallback).not.toHaveBeenCalled();
    expect(mockWriteOutboundDirect).toHaveBeenCalledTimes(1);
    const [, , payload] = mockWriteOutboundDirect.mock.calls[0];
    expect(JSON.parse(payload.content).text).toContain('Fallback not active');
  });

  it('calls exitFallback unconditionally (manual) when fallback is active', async () => {
    enterFallbackState({
      mode: 'auto',
      classification: 'quota',
      reason: 'r',
      backupModel: null,
      backupProvider: 'opencode',
      resetAt: null,
      nextRetryAt: null,
      originSessionId: 'sess-1',
      originGroupId: AGENT_GROUP_ID,
    });

    const handled = await interceptFallbackCommand(
      chatContent('/fallback return'),
      OWNER_ID,
      makeSession(AGENT_GROUP_ID),
      deliveryAddr,
    );
    expect(handled).toBe(true);
    expect(mockExitFallback).toHaveBeenCalledTimes(1);
    expect(mockExitFallback).toHaveBeenCalledWith({ via: 'manual' });
    // No status reply is sent directly by commands.ts in this branch — exitFallback owns notification.
    expect(mockWriteOutboundDirect).not.toHaveBeenCalled();
  });
});

describe('interceptFallbackCommand — content parsing', () => {
  it('falls back to raw content when JSON.parse fails', async () => {
    const handled = await interceptFallbackCommand(
      '/fallback status',
      OWNER_ID,
      makeSession(AGENT_GROUP_ID),
      deliveryAddr,
    );
    expect(handled).toBe(true);
    expect(mockWriteOutboundDirect).toHaveBeenCalledTimes(1);
  });
});
