/**
 * pr-factory slack-bots guard — the router's sibling-mention suppression
 * reach-in: the one-line `if (hasSiblingMention(mg, text)) return false;`
 * in evaluateEngage's 'mention-sticky' case (src/router.ts), immediately
 * after the DM short-circuit and before the sticky-session lookup.
 *
 * Driven through the REAL routeInbound against a real migrated central DB
 * and real on-disk session DBs (container spawn mocked away). Goes red if
 * the router call is deleted, or if the helper's sibling query
 * (src/channels/sibling-mention.ts — named-instance rows on the same
 * channel, engage_mode='mention') drifts off the messaging_groups instance
 * schema.
 *
 * Scenario (the PR Factory channel): the supervisor holds a mention-sticky
 * wiring on a shared Slack channel; the tester sits on the same channel as a
 * named-instance mention-mode sibling. A follow-up in an already-engaged
 * thread that starts with '@' (addressed to the sibling) must NOT fire the
 * sticky wiring; a plain follow-up must. With no sibling, '@'-prefixed
 * follow-ups pass through unchanged.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-sibling-mention' };
});

const TEST_DIR = '/tmp/nanoclaw-test-sibling-mention';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { routeInbound } from './router.js';
import { inboundDbPath, resolveSession } from './session-manager.js';
import type { InboundEvent } from './channels/adapter.js';

function now(): string {
  return new Date().toISOString();
}

function event(partial: Partial<InboundEvent> & { text: string; isMention?: boolean }): InboundEvent {
  return {
    channelType: 'slack',
    platformId: 'CS',
    threadId: null,
    instance: partial.instance,
    message: {
      id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      content: JSON.stringify({ text: partial.text, sender: 'User', senderId: 'U1' }),
      timestamp: now(),
      isMention: partial.isMention ?? false,
      isGroup: true,
    },
    ...Object.fromEntries(Object.entries(partial).filter(([k]) => !['text', 'isMention', 'message'].includes(k))),
  } as InboundEvent;
}

function countInbound(agentGroupId: string, sessionId: string): number {
  const db = new Database(inboundDbPath(agentGroupId, sessionId));
  const n = (db.prepare('SELECT count(*) AS n FROM messages_in').get() as { n: number }).n;
  db.close();
  return n;
}

function wire(opts: { mgaId: string; mgId: string; agId: string; engageMode: string }): void {
  createMessagingGroupAgent({
    id: opts.mgaId,
    messaging_group_id: opts.mgId,
    agent_group_id: opts.agId,
    engage_mode: opts.engageMode as never,
    engage_pattern: opts.engageMode === 'pattern' ? '.' : null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    created_at: now(),
  });
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

describe('router sibling-mention suppression (instance-keyed)', () => {
  it("suppresses mention-sticky follow-ups starting '@' when a sibling mention-mode instance shares the channel", async () => {
    createAgentGroup({ id: 'ag-super', name: 'Super', folder: 'super', agent_provider: null, created_at: now() });
    createAgentGroup({ id: 'ag-test', name: 'Tester', folder: 'tester', agent_provider: null, created_at: now() });
    createMessagingGroup({
      id: 'mg-super',
      channel_type: 'slack',
      platform_id: 'CS',
      instance: 'slack-supervisor',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-test',
      channel_type: 'slack',
      platform_id: 'CS',
      instance: 'slack-tester',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    wire({ mgaId: 'mga-super', mgId: 'mg-super', agId: 'ag-super', engageMode: 'mention-sticky' });
    wire({ mgaId: 'mga-test', mgId: 'mg-test', agId: 'ag-test', engageMode: 'mention' });

    // Pre-existing sticky session for the supervisor on thread T1 —
    // follow-ups in this thread normally engage without a mention.
    const { session } = resolveSession('ag-super', 'mg-super', 'T1', 'per-thread');

    // '@'-addressed to the sibling → suppressed, nothing written.
    await routeInbound(event({ text: '@pr-tester please test this', threadId: 'T1', instance: 'slack-supervisor' }));
    expect(countInbound('ag-super', session.id)).toBe(0);

    // Plain follow-up → sticky engage, message lands.
    await routeInbound(event({ text: 'carry on', threadId: 'T1', instance: 'slack-supervisor' }));
    expect(countInbound('ag-super', session.id)).toBe(1);

    stopTypingRefresh(session.id);
  });

  it("lets '@'-prefixed sticky follow-ups through when NO sibling mention-mode instance exists", async () => {
    createAgentGroup({ id: 'ag-solo', name: 'Solo', folder: 'solo', agent_provider: null, created_at: now() });
    createMessagingGroup({
      id: 'mg-solo',
      channel_type: 'slack',
      platform_id: 'CS2',
      instance: 'slack-supervisor',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    wire({ mgaId: 'mga-solo', mgId: 'mg-solo', agId: 'ag-solo', engageMode: 'mention-sticky' });
    const { session } = resolveSession('ag-solo', 'mg-solo', 'T1', 'per-thread');

    await routeInbound(
      event({ text: '@someone unrelated', threadId: 'T1', platformId: 'CS2', instance: 'slack-supervisor' }),
    );
    expect(countInbound('ag-solo', session.id)).toBe(1);

    stopTypingRefresh(session.id);
  });

  it('the default instance never counts as a sibling (worker row on the same channel)', async () => {
    createAgentGroup({ id: 'ag-super', name: 'Super', folder: 'super', agent_provider: null, created_at: now() });
    createAgentGroup({ id: 'ag-work', name: 'Worker', folder: 'worker', agent_provider: null, created_at: now() });
    createMessagingGroup({
      id: 'mg-super',
      channel_type: 'slack',
      platform_id: 'CS3',
      instance: 'slack-supervisor',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    // Default-instance worker row, wired mention-mode: must NOT suppress —
    // only NAMED sibling instances are mention-addressed bots.
    createMessagingGroup({
      id: 'mg-work',
      channel_type: 'slack',
      platform_id: 'CS3',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    wire({ mgaId: 'mga-super', mgId: 'mg-super', agId: 'ag-super', engageMode: 'mention-sticky' });
    wire({ mgaId: 'mga-work', mgId: 'mg-work', agId: 'ag-work', engageMode: 'mention' });

    const { session } = resolveSession('ag-super', 'mg-super', 'T1', 'per-thread');

    await routeInbound(
      event({ text: '@someone hello', threadId: 'T1', platformId: 'CS3', instance: 'slack-supervisor' }),
    );
    expect(countInbound('ag-super', session.id)).toBe(1);

    stopTypingRefresh(session.id);
  });
});
