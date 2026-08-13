/**
 * mention-sticky scope tests.
 *
 * A session can exist without the thread ever engaging: (1) at channel
 * level, threadId equals the messaging group's platform id, so one
 * channel-level mention would subscribe the entire channel; (2) with
 * ignored_message_policy='accumulate', sessions are created just to store
 * silent context (trigger=0). Sticky must fire only for genuine sub-threads
 * that have seen a triggered message.
 */
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-router-engage' };
});

const TEST_DIR = '/tmp/nanoclaw-test-router-engage';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { resolveSession, writeSessionMessage } from './session-manager.js';
import { evaluateEngage } from './router.js';
import type { MessagingGroup, MessagingGroupAgent } from './types.js';

const CHANNEL = 'discord:guild-1:chan-1';

function stickyAgent(): MessagingGroupAgent {
  return {
    id: 'wiring-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'mention-sticky',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    created_at: new Date().toISOString(),
  } as MessagingGroupAgent;
}

function groupChat(): MessagingGroup {
  return {
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: CHANNEL,
    instance: 'discord',
    name: null,
    is_group: 1,
    unknown_sender_policy: 'public',
    denied_at: null,
    created_at: new Date().toISOString(),
  } as MessagingGroup;
}

function seedSessionWithMessage(threadId: string, trigger: 0 | 1): void {
  const { session } = resolveSession('ag-1', 'mg-1', threadId, 'per-thread');
  writeSessionMessage('ag-1', session.id, {
    id: `m-${trigger}-${threadId}`,
    kind: 'chat-sdk',
    timestamp: new Date().toISOString(),
    platformId: CHANNEL,
    channelType: 'discord',
    threadId,
    content: JSON.stringify({ text: 'hi' }),
    trigger,
  });
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: 'ag-1',
    name: 'Agent',
    folder: 'agent-1',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  createMessagingGroup(groupChat());
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('evaluateEngage — mention-sticky scope', () => {
  it('fires on a platform mention regardless of session state', () => {
    expect(evaluateEngage(stickyAgent(), 'hey', true, groupChat(), `${CHANNEL}:thread-9`)).toBe(true);
  });

  it('does not fire without a mention when no session exists', () => {
    expect(evaluateEngage(stickyAgent(), 'hey', false, groupChat(), `${CHANNEL}:thread-9`)).toBe(false);
  });

  it('does not subscribe the channel root even when a channel-root session exists', () => {
    seedSessionWithMessage(CHANNEL, 1);
    expect(evaluateEngage(stickyAgent(), 'hey', false, groupChat(), CHANNEL)).toBe(false);
  });

  it('does not treat an accumulate-only session (trigger=0 rows) as subscribed', () => {
    seedSessionWithMessage(`${CHANNEL}:thread-1`, 0);
    expect(evaluateEngage(stickyAgent(), 'hey', false, groupChat(), `${CHANNEL}:thread-1`)).toBe(false);
  });

  it('stays sticky in a sub-thread that has seen a triggered message', () => {
    seedSessionWithMessage(`${CHANNEL}:thread-2`, 1);
    expect(evaluateEngage(stickyAgent(), 'hey', false, groupChat(), `${CHANNEL}:thread-2`)).toBe(true);
  });
});
