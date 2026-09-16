/**
 * Room canvas creation tests (contract C2): template shape (the canvas IS the
 * room contract; no bot mentions in the body), the
 * conversations.canvases.create call, and the non-throwing failure paths.
 * Plus the canvas-comments shadow-channel wiring (F→C derivation, one mg row
 * + wiring per participating instance, idempotence, non-throwing).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TIMEZONE } from '../../config.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import {
  getAllMessagingGroups,
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { formatLocalTime } from '../../timezone.js';
import {
  createRoomCanvas,
  deriveCanvasShadowChannelId,
  roomCanvasMarkdown,
  wireCanvasComments,
} from './room-canvas.js';

const OPTS = {
  roomName: 'Pixel room',
  purpose: 'Design work between Gavriel, Pixel, and Mark.\nSecond purpose line.',
  creatorUserId: 'U0CREATOR',
  agentNames: ['Pixel', 'Mark', 'Pixel'],
  createdAt: '2026-08-01T12:00:00.000Z',
};

describe('roomCanvasMarkdown', () => {
  const md = roomCanvasMarkdown(OPTS);

  it('leads with the blockquoted purpose — no body H1 (the create-call `title` param renders the document title; a body heading duplicated it, live-observed)', () => {
    expect(md.startsWith('> Design work between Gavriel, Pixel, and Mark.')).toBe(true);
    expect(md).not.toContain('# Pixel room');
    expect(md).toContain('> Second purpose line.');
  });

  it('carries the room-contract data: creator card, created date, Members table', () => {
    expect(md).toContain(`Created by ![](@U0CREATOR) on ${formatLocalTime(OPTS.createdAt, TIMEZONE)}.`);
    expect(md).toContain('## Members');
    expect(md).toContain('| ![](@U0CREATOR) | creator |');
  });

  it('lists agents by PLAIN NAME, deduped — never as user cards', () => {
    expect(md).toContain('| Pixel | agent |');
    expect(md).toContain('| Mark | agent |');
    expect(md.match(/\| Pixel \| agent \|/g)).toHaveLength(1);
  });

  it('never @-mentions a bot: the only user card is the human creator', () => {
    const cards = md.match(/!\[\]\(@\w+\)/g) ?? [];
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) expect(card).toBe('![](@U0CREATOR)');
    expect(md).not.toContain('<@');
  });

  it('carries the Tasks checklist and the Decisions / Notes sections', () => {
    expect(md).toContain('## Tasks');
    expect(md).toContain('- [ ] ');
    expect(md).toContain('## Decisions');
    expect(md).toContain('## Notes');
  });
});

describe('createRoomCanvas', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the template to conversations.canvases.create and returns the canvas id', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, canvas_id: 'F0CANVAS1' }), { status: 200 }),
    );

    const id = await createRoomCanvas('xoxb-test-token', 'C0ROOM', OPTS);

    expect(id).toBe('F0CANVAS1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://slack.com/api/conversations.canvases.create');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-test-token');
    const body = JSON.parse(init.body as string);
    expect(body.channel_id).toBe('C0ROOM');
    expect(body.document_content).toEqual({ type: 'markdown', markdown: roomCanvasMarkdown(OPTS) });
  });

  it('returns undefined on a Slack error instead of throwing', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: 'free_team_not_allowed' }), { status: 200 }),
    );
    await expect(createRoomCanvas('xoxb-test-token', 'C0ROOM', OPTS)).resolves.toBeUndefined();
  });

  it('returns undefined when fetch itself rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(createRoomCanvas('xoxb-test-token', 'C0ROOM', OPTS)).resolves.toBeUndefined();
  });

  it('returns undefined when ok:true carries no canvas_id', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(createRoomCanvas('xoxb-test-token', 'C0ROOM', OPTS)).resolves.toBeUndefined();
  });
});

describe('deriveCanvasShadowChannelId', () => {
  it('swaps the leading F for C on a canvas-shaped id', () => {
    expect(deriveCanvasShadowChannelId('F0BME4DL401')).toBe('C0BME4DL401');
    expect(deriveCanvasShadowChannelId('F1')).toBe('C1');
  });

  it('returns undefined for anything not canvas-id shaped', () => {
    for (const bad of ['C0BME4DL401', 'F', '', 'F0bme4dl401', 'F0BME-4DL401', 'X0BME4DL401', ' F0BME4DL401']) {
      expect(deriveCanvasShadowChannelId(bad)).toBeUndefined();
    }
  });
});

describe('wireCanvasComments', () => {
  const CREATOR = { instanceKey: 'slack-pixel', agentGroupId: 'ag-pixel' };
  // Creator deliberately ALSO present in the list — must not double-wire.
  const PARTICIPANTS = [
    { instanceKey: 'slack', agentGroupId: 'ag-andy' },
    { instanceKey: 'slack-mark', agentGroupId: 'ag-mark' },
    CREATOR,
  ];

  beforeEach(async () => {
    const db = await initTestDb();
    await runMigrations(db);
    const now = new Date().toISOString();
    for (const [id, name, folder] of [
      ['ag-pixel', 'Pixel', 'pixel'],
      ['ag-andy', 'Andy', 'andy'],
      ['ag-mark', 'Mark', 'mark'],
    ] as const) {
      await createAgentGroup({ id, name, folder, agent_provider: null, created_at: now });
    }
  });

  afterEach(async () => {
    await closeDb();
  });

  it('wires EVERY participating instance: creator pattern-engage, siblings mention/accumulate', async () => {
    const shadowId = await wireCanvasComments('F0CANVAS1', CREATOR, PARTICIPANTS, 'Pixel room');

    expect(shadowId).toBe('C0CANVAS1');
    // One mg row PER instance (router lookup is exact-on-instance), all public.
    const all = (await getAllMessagingGroups()).filter((m) => m.platform_id === 'slack:C0CANVAS1');
    expect(all).toHaveLength(3);
    for (const p of PARTICIPANTS) {
      const mg = await getMessagingGroupByPlatform('slack', 'slack:C0CANVAS1', p.instanceKey);
      expect(mg).toMatchObject({
        channel_type: 'slack',
        instance: p.instanceKey,
        name: 'Pixel room canvas comments (canvas F0CANVAS1)',
        is_group: 1,
        unknown_sender_policy: 'public',
      });
      expect(await getMessagingGroupAgents(mg!.id)).toHaveLength(1);
    }
    // Creator = default responder for anchored comments.
    const creatorMg = (await getMessagingGroupByPlatform('slack', 'slack:C0CANVAS1', 'slack-pixel'))!;
    expect(await getMessagingGroupAgentByPair(creatorMg.id, 'ag-pixel')).toMatchObject({
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
    });
    // Siblings = room semantics: mention to trigger, everything else context.
    for (const sibling of [
      { instanceKey: 'slack', agentGroupId: 'ag-andy' },
      { instanceKey: 'slack-mark', agentGroupId: 'ag-mark' },
    ]) {
      const mg = (await getMessagingGroupByPlatform('slack', 'slack:C0CANVAS1', sibling.instanceKey))!;
      expect(await getMessagingGroupAgentByPair(mg.id, sibling.agentGroupId)).toMatchObject({
        engage_mode: 'mention',
        engage_pattern: null,
        sender_scope: 'all',
        ignored_message_policy: 'accumulate',
        session_mode: 'shared',
        priority: 0,
      });
    }
  });

  it('is idempotent: a second call creates no new rows', async () => {
    await wireCanvasComments('F0CANVAS1', CREATOR, PARTICIPANTS, 'Pixel room');
    const mgCount = (await getAllMessagingGroups()).length;
    const mg = (await getMessagingGroupByPlatform('slack', 'slack:C0CANVAS1', 'slack-pixel'))!;
    const wiringId = (await getMessagingGroupAgentByPair(mg.id, 'ag-pixel'))!.id;

    const second = await wireCanvasComments('F0CANVAS1', CREATOR, PARTICIPANTS, 'Pixel room');

    expect(second).toBe('C0CANVAS1');
    expect((await getAllMessagingGroups()).length).toBe(mgCount);
    expect(await getMessagingGroupAgents(mg.id)).toHaveLength(1);
    expect((await getMessagingGroupAgentByPair(mg.id, 'ag-pixel'))!.id).toBe(wiringId);
  });

  it('returns undefined and writes nothing on an invalid canvas id shape', async () => {
    const before = (await getAllMessagingGroups()).length;
    expect(await wireCanvasComments('not-a-canvas', CREATOR, PARTICIPANTS, 'Pixel room')).toBeUndefined();
    expect((await getAllMessagingGroups()).length).toBe(before);
  });

  it('never throws: a DB failure (unknown agent group breaks the FK) returns undefined', async () => {
    expect(
      await wireCanvasComments('F0CANVAS2', { instanceKey: 'slack', agentGroupId: 'ag-missing' }, [], 'X'),
    ).toBeUndefined();
  });
});
