/**
 * Answers to an agent's question (ask_user_question): only one answer reaches
 * the agent, a failed write leaves the question open, and the answer is
 * reported accepted before the agent is woken.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({ wakeContainer: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../session-manager.js', async () => ({
  ...(await vi.importActual('../../session-manager.js')),
  writeSessionMessage: vi.fn().mockResolvedValue(undefined),
}));

import { wakeContainer } from '../../container-runner.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createPendingQuestion, createSession, getPendingQuestion } from '../../db/sessions.js';
import { dispatchResponse } from '../../response-registry.js';
import { writeSessionMessage } from '../../session-manager.js';
import './index.js';

const now = () => new Date().toISOString();
const answer = (value: string) =>
  dispatchResponse({ questionId: 'q-1', value, userId: 'u', channelType: 'slack', platformId: 'C1', threadId: null });

beforeEach(async () => {
  vi.clearAllMocks();
  await runMigrations(await initTestDb());
  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  await createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });
  await createPendingQuestion({
    question_id: 'q-1',
    session_id: 'sess-1',
    message_out_id: 'out-1',
    platform_id: 'C1',
    channel_type: 'slack',
    thread_id: null,
    title: 'Pick one',
    options: [
      { label: 'A', selectedLabel: 'A', value: 'a' },
      { label: 'B', selectedLabel: 'B', value: 'b' },
    ],
    created_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
});

describe('question answers', () => {
  it('lets only one of two concurrent answers reach the agent', async () => {
    const outcomes = await Promise.all([answer('a'), answer('b')]);
    expect([...outcomes].sort()).toEqual(['accepted', 'ignored']);
    expect(writeSessionMessage).toHaveBeenCalledTimes(1);
    expect(await getPendingQuestion('q-1')).toBeUndefined();
  });

  it('keeps the question open when its answer could not be written, so a second click answers it', async () => {
    vi.mocked(writeSessionMessage).mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    expect(await answer('a')).toBe('ignored');
    expect(await getPendingQuestion('q-1')).toBeDefined();
    expect(await answer('b')).toBe('accepted');
    expect(writeSessionMessage).toHaveBeenCalledTimes(2);
    expect(await getPendingQuestion('q-1')).toBeUndefined();
  });

  it('reports the answer accepted before the agent is woken', async () => {
    let wake!: () => void;
    vi.mocked(wakeContainer).mockImplementationOnce(() => new Promise((resolve) => (wake = () => resolve(true))));
    const outcome = await Promise.race([
      answer('a'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 300)),
    ]);
    wake?.();
    expect(outcome).toBe('accepted');
  });
});
