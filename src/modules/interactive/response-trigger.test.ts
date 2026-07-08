/**
 * Regression: a question_response must be written with trigger=0.
 *
 * The response is consumed in place by the ask_user_question tool poll
 * (findQuestionResponse ignores trigger); a cold-woken container's main loop
 * filters out all kind='system' messages and will never process it. A
 * trigger=1 row left orphaned by a button click that arrives after the tool's
 * timeout therefore stays pending forever and makes countDueMessages re-wake
 * an idle container in an endless loop.
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
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-interactive-trigger' };
});

const TEST_DIR = '/tmp/nanoclaw-test-interactive-trigger';

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

describe('question_response inbound write', () => {
  it("writes the response as kind='system' with trigger=0 so it never wakes a cold container", async () => {
    const { createAgentGroup, createMessagingGroup, createPendingQuestion } = await import('../../db/index.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { resolveSession, inboundDbPath } = await import('../../session-manager.js');

    createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'chat-1',
      name: 'Chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    createPendingQuestion({
      question_id: 'q-1',
      session_id: session.id,
      message_out_id: 'out-1',
      platform_id: 'chat-1',
      channel_type: 'telegram',
      thread_id: null,
      title: 'Proceed?',
      options: [{ value: 'yes', label: 'Yes', selectedLabel: 'yes' }],
      created_at: now(),
    });

    let claimed = false;
    for (const handler of getResponseHandlers()) {
      claimed = await handler({
        questionId: 'q-1',
        value: 'yes',
        userId: 'user-1',
        channelType: 'telegram',
        platformId: 'chat-1',
        threadId: null,
      });
      if (claimed) break;
    }
    expect(claimed).toBe(true);

    const inbound = new Database(inboundDbPath('ag-1', session.id));
    const row = inbound
      .prepare('SELECT kind, trigger, status FROM messages_in WHERE content LIKE \'%"questionId":"q-1"%\'')
      .get() as { kind: string; trigger: number; status: string };
    inbound.close();

    expect(row).toBeDefined();
    expect(row.kind).toBe('system');
    expect(row.trigger).toBe(0);
    expect(row.status).toBe('pending');
  });
});
