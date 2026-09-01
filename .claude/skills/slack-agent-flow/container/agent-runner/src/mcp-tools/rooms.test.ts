/**
 * Room MCP tool tests: create_room / add_to_room arg validation and
 * system-action row shape, plus the extendTool-based create_agent extension
 * (schema/description growth + purpose/allow_guests/room payload
 * passthrough) — all fire-and-forget writes to messages_out (authorization
 * is host-side). Importing ./rooms.js applies the extension, so these tests
 * exercise the same wiring the barrel produces.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { createAgent } from './agents.js';
import { addToRoom, createRoom } from './rooms.js';

function outboundActions(): Array<{ id: string; kind: string; content: Record<string, unknown> }> {
  return (
    getOutboundDb().prepare('SELECT id, kind, content FROM messages_out ORDER BY seq').all() as Array<{
      id: string;
      kind: string;
      content: string;
    }>
  ).map((r) => ({ id: r.id, kind: r.kind, content: JSON.parse(r.content) }));
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('create_room — arg validation', () => {
  it('requires name', async () => {
    const r = await createRoom.handler({ agents: ['Pixel'] });
    expect(r.isError).toBe(true);
    expect(outboundActions()).toHaveLength(0);
  });

  it('requires a non-empty agents list of names', async () => {
    for (const agents of [undefined, [], ['  '], 'Pixel']) {
      const r = await createRoom.handler({ name: 'Website Team', agents });
      expect(r.isError).toBe(true);
    }
    expect(outboundActions()).toHaveLength(0);
  });
});

describe('create_room — submission', () => {
  it('writes a create_room system action with the full agent list', async () => {
    const r = await createRoom.handler({
      name: '  Website Team ',
      purpose: 'ship the site',
      agents: ['Pixel', 'Devin'],
    });

    expect(r.isError).toBeUndefined();
    expect((r.content[0] as { text: string }).text).toContain('Creating room "Website Team"');

    const rows = outboundActions();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('system');
    expect(rows[0].content).toMatchObject({
      action: 'create_room',
      name: 'Website Team',
      purpose: 'ship the site',
      agents: ['Pixel', 'Devin'],
    });
    expect(rows[0].content.requestId).toBe(rows[0].id);
    // include_me travels only when explicitly false (host default is true).
    expect(rows[0].content.include_me).toBeUndefined();
  });

  it('carries include_me:false only when explicitly set', async () => {
    await createRoom.handler({ name: 'Duo', agents: ['Pixel'], include_me: false });
    expect(outboundActions()[0].content).toMatchObject({ action: 'create_room', include_me: false });
  });
});

describe('add_to_room', () => {
  it('requires room and agent', async () => {
    const r1 = await addToRoom.handler({ agent: 'Devin' });
    expect(r1.isError).toBe(true);
    const r2 = await addToRoom.handler({ room: 'Website Team' });
    expect(r2.isError).toBe(true);
    expect(outboundActions()).toHaveLength(0);
  });

  it('writes an add_to_room system action', async () => {
    const r = await addToRoom.handler({ room: 'Website Team', agent: 'Devin' });
    expect(r.isError).toBeUndefined();

    const rows = outboundActions();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('system');
    expect(rows[0].content).toMatchObject({ action: 'add_to_room', room: 'Website Team', agent: 'Devin' });
    expect(rows[0].content.requestId).toBe(rows[0].id);
  });
});

describe('create_agent — Slack extension (extendTool)', () => {
  it('extends the base tool schema and description without editing agents.ts', () => {
    const props = (createAgent.tool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(['name', 'instructions', 'purpose', 'allow_guests', 'room']),
    );
    expect(createAgent.tool.description).toContain('acknowledge the user in this SAME turn');
  });

  it('passes the registered keys through into the written system payload', async () => {
    await createAgent.handler({ name: 'Pixel', room: 'none', purpose: 'design things' });
    await createAgent.handler({ name: 'Solo' });
    await createAgent.handler({ name: 'Own', room: 'own' });

    const rows = outboundActions();
    expect(rows).toHaveLength(3);
    expect(rows[0].content).toMatchObject({
      action: 'create_agent',
      name: 'Pixel',
      room: 'none',
      purpose: 'design things',
    });
    // No extension args → the payload stays byte-identical to the base tool's.
    expect(rows[1].content.room).toBeUndefined();
    expect(rows[1].content.purpose).toBeUndefined();
    // The passthrough copies provided values verbatim; the host reads an
    // explicit 'own' exactly as an absent room (both mean the default
    // own-room policy), so nothing normalizes it away container-side.
    expect(rows[2].content.room).toBe('own');
  });
});
