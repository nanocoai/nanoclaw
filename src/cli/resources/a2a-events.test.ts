/**
 * Tests for the read-only `ncl a2a-events` verb.
 *
 * Covers the contract's three load-bearing behaviors:
 *   1. Delivery tailing with a cursor (snapshot → tail → advance → drain).
 *   2. A held a2a message gate (pending_approvals row) → listed in pending_gates.
 *   3. The agents snapshot fields (container_status, heartbeat_age_ms, current_tool).
 * Plus rejections and channel_out tailing.
 *
 * Uses dispatch() with caller 'host' — the same path the governance service's
 * `ncl a2a-events --json` subprocess takes.
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-a2a-events' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-a2a-events';
const EPOCH = '2000-01-01T00:00:00.000Z';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { markDelivered, openInboundDb, openOutboundDbRw } from '../../mailbox/sqlite/session-db.js';
import { createSession, createPendingApproval, getPendingApproval } from '../../db/sessions.js';
import { finalizeReject } from '../../modules/approvals/finalize.js';
import { performAgentRoute } from '../../modules/agent-to-agent/agent-route.js';
import { setMessagePolicy } from '../../modules/agent-to-agent/db/agent-message-policies.js';
import {
  heartbeatPath,
  initSessionFolder,
  writeSessionMessage,
} from '../../session-manager.js';
import type { Session } from '../../types.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `a2a-events` command.
import './a2a-events.js';

function now(): string {
  return new Date().toISOString();
}

const SOURCE = 'ag-source';
const TARGET = 'ag-target';
const SOURCE_SESSION = 'sess-source-1';
const TARGET_SESSION = 'sess-target-1';

function makeSession(
  agentGroupId: string,
  sessionId: string,
  containerStatus: Session['container_status'] = 'stopped',
): Session {
  return {
    id: sessionId,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: containerStatus,
    last_active: null,
    created_at: now(),
  };
}

async function poll(since?: string): Promise<Record<string, unknown>> {
  const resp = await dispatch(
    { id: `req-${Math.random()}`, command: 'a2a-events', args: since ? { since } : {} },
    { caller: 'host' },
  );
  expect(resp.ok).toBe(true);
  if (!resp.ok) throw new Error('unreachable');
  return resp.data as Record<string, unknown>;
}

describe('a2a-events CLI verb', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = await initTestDb();
    await runMigrations(db);

    await createAgentGroup({ id: SOURCE, name: 'researcher', folder: 'researcher', agent_provider: null, created_at: now() });
    await createAgentGroup({ id: TARGET, name: 'writer', folder: 'writer', agent_provider: null, created_at: now() });

    await createSession(makeSession(SOURCE, SOURCE_SESSION));
    await createSession(makeSession(TARGET, TARGET_SESSION));
    initSessionFolder(SOURCE, SOURCE_SESSION);
    initSessionFolder(TARGET, TARGET_SESSION);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('without --since returns a snapshot: empty event arrays and a now-ish cursor', async () => {
    // A pre-existing delivery must NOT appear in the snapshot.
    await performAgentRoute(
      { id: 'msg-1', platform_id: TARGET, content: JSON.stringify({ text: 'hi' }), in_reply_to: null },
      makeSession(SOURCE, SOURCE_SESSION),
      TARGET,
    );

    const before = Date.now();
    const data = await poll();
    const after = Date.now();

    expect(data.deliveries).toEqual([]);
    expect(data.channel_out).toEqual([]);
    expect(data.rejections).toEqual([]);
    expect(Array.isArray(data.agents)).toBe(true);
    expect(Array.isArray(data.pending_gates)).toBe(true);

    const nowTs = Date.parse(data.now as string);
    expect(nowTs).toBeGreaterThanOrEqual(before);
    expect(nowTs).toBeLessThanOrEqual(after);
    expect(data.cursor).toBe(data.now);
  });

  it('tails deliveries with --since and advances the cursor to the max event ts', async () => {
    await performAgentRoute(
      { id: 'msg-1', platform_id: TARGET, content: JSON.stringify({ text: 'draft the report' }), in_reply_to: null },
      makeSession(SOURCE, SOURCE_SESSION),
      TARGET,
    );

    const data = await poll(EPOCH);
    const deliveries = data.deliveries as Array<Record<string, unknown>>;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ from: SOURCE, to: TARGET, was_gated: false, preview: 'draft the report' });
    expect(typeof deliveries[0]!.ts).toBe('string');
    // Cursor is the delivery's ts (max event ts seen).
    expect(data.cursor).toBe(deliveries[0]!.ts);

    // Passing the cursor back verbatim drains the feed (ts > cursor is strict).
    const next = await poll(data.cursor as string);
    expect(next.deliveries).toEqual([]);
    expect(next.cursor).toBe(data.cursor);
  });

  it('marks deliveries on a gated edge as was_gated', async () => {
    await setMessagePolicy(SOURCE, TARGET, 'slack:U-approver', now());

    // Simulates the post-approval re-route (applyA2aMessageGate → performAgentRoute).
    await performAgentRoute(
      { id: 'msg-1', platform_id: TARGET, content: JSON.stringify({ text: 'approved content' }), in_reply_to: null },
      makeSession(SOURCE, SOURCE_SESSION),
      TARGET,
    );

    const data = await poll(EPOCH);
    const deliveries = data.deliveries as Array<Record<string, unknown>>;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ from: SOURCE, to: TARGET, was_gated: true });
  });

  it('lists a held a2a message gate in pending_gates with from/to/approver/preview', async () => {
    const longText = 'please forward this to the writer '.repeat(10); // > 120 chars
    await createPendingApproval({
      approval_id: 'appr-1',
      session_id: SOURCE_SESSION,
      request_id: 'appr-1',
      action: 'a2a_message_gate',
      payload: JSON.stringify({
        id: 'msg-held',
        platform_id: TARGET,
        content: JSON.stringify({ text: longText }),
        in_reply_to: null,
      }),
      created_at: now(),
      title: 'Message approval',
      options_json: '[]',
      approver_user_id: 'slack:U-approver',
    });
    // A non-a2a approval must not leak into pending_gates.
    await createPendingApproval({
      approval_id: 'appr-2',
      session_id: SOURCE_SESSION,
      request_id: 'appr-2',
      action: 'install_packages',
      payload: JSON.stringify({ packages: ['jq'] }),
      created_at: now(),
      title: 'Install packages',
      options_json: '[]',
    });

    const data = await poll();
    const gates = data.pending_gates as Array<Record<string, unknown>>;
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      id: 'appr-1',
      from: SOURCE,
      to: TARGET,
      approver: 'slack:U-approver',
    });
    expect(typeof gates[0]!.created_at).toBe('string');
    expect(gates[0]!.preview).toBe(longText.slice(0, 120));
  });

  it('reports agents snapshot: container_status, heartbeat_age_ms, current_tool', async () => {
    // Source: running container with a fresh heartbeat and a tool in flight.
    await createSession(makeSession(SOURCE, 'sess-source-2', 'running'));
    initSessionFolder(SOURCE, 'sess-source-2');
    fs.writeFileSync(heartbeatPath(SOURCE, 'sess-source-2'), '');

    const outDb = openOutboundDbRw(outboundDbPath(SOURCE, 'sess-source-2'));
    outDb
      .prepare(
        `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
         VALUES (1, 'Bash', NULL, NULL, ?)`,
      )
      .run(now());
    outDb.close();

    const data = await poll();
    const agents = data.agents as Array<Record<string, unknown>>;
    const source = agents.find((a) => a.id === SOURCE)!;
    const target = agents.find((a) => a.id === TARGET)!;

    expect(source).toMatchObject({
      name: 'researcher',
      folder: 'researcher',
      container_status: 'running',
      current_tool: 'Bash',
    });
    expect(typeof source.heartbeat_age_ms).toBe('number');
    expect(source.heartbeat_age_ms as number).toBeGreaterThanOrEqual(0);
    expect(source.heartbeat_age_ms as number).toBeLessThan(60_000);

    // Target: no container, no heartbeat file.
    expect(target).toMatchObject({
      name: 'writer',
      container_status: 'stopped',
      heartbeat_age_ms: null,
      current_tool: null,
    });
  });

  it('surfaces a2a gate rejection notes since the cursor', async () => {
    // finalizeReject writes this shape into the SOURCE session's inbound.
    await writeSessionMessage(SOURCE, SOURCE_SESSION, {
      id: 'appr-note-1234-abcd',
      kind: 'chat',
      timestamp: now(),
      platformId: SOURCE,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: 'Your a2a_message_gate request was rejected by admin.',
        sender: 'system',
        senderId: 'system',
      }),
    });
    // With a single gated edge from SOURCE, `to` is attributed to it.
    await setMessagePolicy(SOURCE, TARGET, 'slack:U-approver', now());

    const data = await poll(EPOCH);
    const rejections = data.rejections as Array<Record<string, unknown>>;
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ from: SOURCE, to: TARGET });
    // The note itself must not be double-counted as a delivery.
    expect(data.deliveries).toEqual([]);
  });

  it('attributes a finalizeReject rejection to the exact target even with multiple gated edges', async () => {
    const EDITOR = 'ag-editor';
    await createAgentGroup({ id: EDITOR, name: 'editor', folder: 'editor', agent_provider: null, created_at: now() });
    // TWO gated outgoing edges from SOURCE — the sole-gated-edge fallback
    // cannot attribute this; the note's embedded a2a_target must.
    await setMessagePolicy(SOURCE, TARGET, 'slack:U-approver', now());
    await setMessagePolicy(SOURCE, EDITOR, 'slack:U-approver', now());

    await createPendingApproval({
      approval_id: 'appr-rej-1',
      session_id: SOURCE_SESSION,
      request_id: 'appr-rej-1',
      action: 'a2a_message_gate',
      payload: JSON.stringify({
        id: 'msg-held',
        platform_id: EDITOR,
        content: JSON.stringify({ text: 'hold me' }),
        in_reply_to: null,
      }),
      created_at: now(),
      title: 'Message approval',
      options_json: '[]',
      approver_user_id: 'slack:U-approver',
    });
    const approval = (await getPendingApproval('appr-rej-1'))!;
    await finalizeReject(approval, makeSession(SOURCE, SOURCE_SESSION), 'slack:U-approver');

    const data = await poll(EPOCH);
    const rejections = data.rejections as Array<Record<string, unknown>>;
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ from: SOURCE, to: EDITOR });
  });

  it('reports agent→channel deliveries in channel_out since the cursor', async () => {
    // Container wrote an outbound channel message…
    const outDb = openOutboundDbRw(outboundDbPath(SOURCE, SOURCE_SESSION));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
         VALUES ('m-out-1', 1, ?, 'chat', 'C123', 'slack', NULL, '{"text":"final report"}')`,
      )
      .run(now());
    outDb.close();

    // …and the host marked it delivered.
    const inDb = openInboundDb(inboundDbPath(SOURCE, SOURCE_SESSION));
    markDelivered(inDb, 'm-out-1', 'slack-ts-1');
    inDb.close();

    const data = await poll(EPOCH);
    const channelOut = data.channel_out as Array<Record<string, unknown>>;
    expect(channelOut).toHaveLength(1);
    expect(channelOut[0]).toMatchObject({ from: SOURCE, platform_id: 'C123' });
    // ts is ISO-8601 UTC (ms-resolution for new rows; toIso normalizes legacy SQLite-format rows).
    expect(channelOut[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Cursor advances so the next poll drains.
    const next = await poll(data.cursor as string);
    expect(next.channel_out).toEqual([]);
  });

  it('does not drop a channel_out event that lands in the same second as the cursor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));

    const outDb = openOutboundDbRw(outboundDbPath(SOURCE, SOURCE_SESSION));
    const ins = outDb.prepare(
      `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, ?, 'chat', 'C123', 'slack', NULL, '{"text":"beat"}')`,
    );
    ins.run('m-out-1', 1, now());
    ins.run('m-out-2', 2, now());
    outDb.close();

    const inDb = openInboundDb(inboundDbPath(SOURCE, SOURCE_SESSION));
    markDelivered(inDb, 'm-out-1', 'slack-ts-1');

    // delivered_at must carry milliseconds — second resolution is what made
    // same-second events invisible to strict `> cursor` tailing.
    const first = inDb.prepare("SELECT delivered_at FROM delivered WHERE message_out_id = 'm-out-1'").get() as {
      delivered_at: string;
    };
    expect(first.delivered_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const one = await poll(EPOCH);
    expect(one.channel_out as unknown[]).toHaveLength(1);

    // Second delivery lands (almost certainly) within the same wall-clock
    // second as the cursor — it must still surface on the next poll.
    vi.setSystemTime(new Date('2030-01-01T00:00:00.001Z'));
    markDelivered(inDb, 'm-out-2', 'slack-ts-2');
    inDb.close();

    const two = await poll(one.cursor as string);
    const channelOut = two.channel_out as Array<Record<string, unknown>>;
    expect(channelOut).toHaveLength(1);
    expect(channelOut[0]).toMatchObject({ from: SOURCE, platform_id: 'C123' });

    // And the advanced cursor drains it.
    const three = await poll(two.cursor as string);
    expect(three.channel_out).toEqual([]);
  });
});
