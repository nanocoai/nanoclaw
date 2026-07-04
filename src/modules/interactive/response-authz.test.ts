/**
 * Security regression proof for generic ask_user_question responses.
 *
 * A pending question is delivered to the original chat/user, but the host-side
 * response handler must not accept a forged button-click from an unrelated
 * sender/channel. If it does, an attacker who can guess/obtain the questionId
 * can inject a `question_response` into the agent's inbound session.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-interactive-authz' };
});

const TEST_DIR = '/tmp/nanoclaw-test-interactive-authz';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const { initTestDb, runMigrations } = await import('../../db/index.js');
  const db = initTestDb();
  runMigrations(db);

  // Registers the generic ask_user_question response handler.
  await import('./index.js');
});

afterEach(async () => {
  const { closeDb } = await import('../../db/index.js');
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('generic ask_user_question response authorization', () => {
  it('does not accept a response from a different sender/channel than the pending question destination', async () => {
    const { createAgentGroup, createMessagingGroup, createPendingQuestion } = await import('../../db/index.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { resolveSession, inboundDbPath } = await import('../../session-manager.js');

    createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
    createMessagingGroup({
      id: 'mg-victim',
      channel_type: 'telegram',
      platform_id: 'victim-chat',
      name: 'Victim chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', 'mg-victim', null, 'shared');
    createPendingQuestion({
      question_id: 'q-sensitive',
      session_id: session.id,
      message_out_id: 'out-1',
      platform_id: 'victim-chat',
      channel_type: 'telegram',
      thread_id: null,
      title: 'Sensitive approval?',
      options: [
        { value: 'approve', label: 'Approve', selectedLabel: 'approved' },
        { value: 'deny', label: 'Deny', selectedLabel: 'denied' },
      ],
      created_at: now(),
    });

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: 'q-sensitive',
        value: 'approve',
        userId: 'attacker',
        channelType: 'telegram',
        platformId: 'attacker-chat',
        threadId: null,
      });
      if (claimed) break;
    }

    const inDb = new Database(inboundDbPath('ag-1', session.id));
    try {
      const injected = inDb
        .prepare(
          `SELECT content FROM messages_in
           WHERE kind = 'system' AND content LIKE '%question_response%'`,
        )
        .all() as Array<{ content: string }>;
      expect(injected).toHaveLength(0);
    } finally {
      inDb.close();
    }

    const { getPendingQuestion } = await import('../../db/index.js');
    expect(getPendingQuestion('q-sensitive')).not.toBeNull();
  });

  it('accepts a response from the original pending-question destination', async () => {
    const { createAgentGroup, createMessagingGroup, createPendingQuestion } = await import('../../db/index.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { resolveSession, inboundDbPath } = await import('../../session-manager.js');

    createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
    createMessagingGroup({
      id: 'mg-victim',
      channel_type: 'telegram',
      platform_id: 'victim-chat',
      name: 'Victim chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', 'mg-victim', null, 'shared');
    createPendingQuestion({
      question_id: 'q-sensitive',
      session_id: session.id,
      message_out_id: 'out-1',
      platform_id: 'victim-chat',
      channel_type: 'telegram',
      thread_id: null,
      title: 'Sensitive approval?',
      options: [
        { value: 'approve', label: 'Approve', selectedLabel: 'approved' },
        { value: 'deny', label: 'Deny', selectedLabel: 'denied' },
      ],
      created_at: now(),
    });

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: 'q-sensitive',
        value: 'approve',
        userId: 'authorized-user',
        channelType: 'telegram',
        platformId: 'victim-chat',
        threadId: null,
      });
      if (claimed) break;
    }

    const inDb = new Database(inboundDbPath('ag-1', session.id));
    try {
      const injected = inDb
        .prepare(
          `SELECT content FROM messages_in
           WHERE kind = 'system' AND content LIKE '%question_response%'`,
        )
        .all() as Array<{ content: string }>;
      expect(injected).toHaveLength(1);
      expect(JSON.parse(injected[0].content)).toMatchObject({
        type: 'question_response',
        questionId: 'q-sensitive',
        selectedOption: 'approve',
        userId: 'authorized-user',
      });
    } finally {
      inDb.close();
    }

    const { getPendingQuestion } = await import('../../db/index.js');
    expect(getPendingQuestion('q-sensitive')).toBeUndefined();
  });

  it('accepts a root-channel thread id for a non-threaded pending question destination', async () => {
    const { createAgentGroup, createMessagingGroup, createPendingQuestion } = await import('../../db/index.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { resolveSession, inboundDbPath } = await import('../../session-manager.js');

    createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
    createMessagingGroup({
      id: 'mg-victim',
      channel_type: 'telegram',
      platform_id: 'telegram:12345',
      name: 'Victim DM',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', 'mg-victim', null, 'shared');
    createPendingQuestion({
      question_id: 'q-root-thread',
      session_id: session.id,
      message_out_id: 'out-1',
      platform_id: 'telegram:12345',
      channel_type: 'telegram',
      thread_id: null,
      title: 'Choose an option',
      options: [
        { value: 'yes', label: 'Yes', selectedLabel: 'yes' },
        { value: 'no', label: 'No', selectedLabel: 'no' },
      ],
      created_at: now(),
    });

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: 'q-root-thread',
        value: 'yes',
        userId: 'authorized-user',
        channelType: 'telegram',
        platformId: 'telegram:12345',
        threadId: 'telegram:12345',
      });
      if (claimed) break;
    }

    const inDb = new Database(inboundDbPath('ag-1', session.id));
    try {
      const injected = inDb
        .prepare(
          `SELECT content FROM messages_in
           WHERE kind = 'system' AND content LIKE '%question_response%'`,
        )
        .all() as Array<{ content: string }>;
      expect(injected).toHaveLength(1);
      expect(JSON.parse(injected[0].content)).toMatchObject({
        type: 'question_response',
        questionId: 'q-root-thread',
        selectedOption: 'yes',
        userId: 'authorized-user',
      });
    } finally {
      inDb.close();
    }
  });

  it('rejects a non-root thread id for a non-threaded pending question destination', async () => {
    const { createAgentGroup, createMessagingGroup, createPendingQuestion, getPendingQuestion } =
      await import('../../db/index.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { resolveSession, inboundDbPath } = await import('../../session-manager.js');

    createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
    createMessagingGroup({
      id: 'mg-victim',
      channel_type: 'telegram',
      platform_id: 'telegram:12345',
      name: 'Victim DM',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', 'mg-victim', null, 'shared');
    createPendingQuestion({
      question_id: 'q-other-thread',
      session_id: session.id,
      message_out_id: 'out-1',
      platform_id: 'telegram:12345',
      channel_type: 'telegram',
      thread_id: null,
      title: 'Choose an option',
      options: [{ value: 'yes', label: 'Yes', selectedLabel: 'yes' }],
      created_at: now(),
    });

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: 'q-other-thread',
        value: 'yes',
        userId: 'attacker',
        channelType: 'telegram',
        platformId: 'telegram:12345',
        threadId: 'telegram:other-thread',
      });
      if (claimed) break;
    }

    const inDb = new Database(inboundDbPath('ag-1', session.id));
    try {
      const injected = inDb
        .prepare(
          `SELECT content FROM messages_in
           WHERE kind = 'system' AND content LIKE '%question_response%'`,
        )
        .all() as Array<{ content: string }>;
      expect(injected).toHaveLength(0);
    } finally {
      inDb.close();
    }
    expect(getPendingQuestion('q-other-thread')).not.toBeNull();
  });
});
