/**
 * Canvas MCP tool tests: canvas_update arg validation + system-action row
 * shape, and canvas_read's blocking poll round trip against a host-written
 * canvas_response row (the ncl / ask_user_question pattern).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { canvasRead, canvasUpdate } from './canvas.js';

function outboundActions(): Array<{ id: string; kind: string; content: Record<string, unknown> }> {
  return (
    getOutboundDb().prepare('SELECT id, kind, content FROM messages_out ORDER BY seq').all() as Array<{
      id: string;
      kind: string;
      content: string;
    }>
  ).map((r) => ({ id: r.id, kind: r.kind, content: JSON.parse(r.content) }));
}

function seedCanvasResponse(requestId: string, body: Record<string, unknown>): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, content)
       VALUES ($id, $seq, 'system', $timestamp, 'pending', $content)`,
    )
    .run({
      $id: `canvas-resp-${requestId}`,
      $seq: 2,
      $timestamp: new Date().toISOString(),
      $content: JSON.stringify({ type: 'canvas_response', requestId, action: 'canvas_read', ...body }),
    });
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('canvas_update — arg validation', () => {
  it('requires canvas_id and markdown', async () => {
    const r1 = await canvasUpdate.handler({ op: 'append', markdown: 'x' });
    expect(r1.isError).toBe(true);
    const r2 = await canvasUpdate.handler({ canvas_id: 'F1', op: 'append' });
    expect(r2.isError).toBe(true);
    expect(outboundActions()).toHaveLength(0);
  });

  it('rejects unknown ops', async () => {
    const r = await canvasUpdate.handler({ canvas_id: 'F1', op: 'replace', markdown: 'x' });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('op must be one of');
    expect(outboundActions()).toHaveLength(0);
  });

  it('rejects section ops without section_text — nothing is submitted', async () => {
    for (const op of ['replace_section', 'insert_after_section']) {
      const r = await canvasUpdate.handler({ canvas_id: 'F1', op, markdown: 'x' });
      expect(r.isError).toBe(true);
      expect((r.content[0] as { text: string }).text).toContain('section_text');
    }
    expect(outboundActions()).toHaveLength(0);
  });
});

describe('canvas_update — submission', () => {
  it('writes a canvas_edit system action and returns fire-and-forget text', async () => {
    const r = await canvasUpdate.handler({
      canvas_id: 'F1',
      op: 'replace_section',
      section_text: 'Tasks',
      markdown: '## Tasks\n\n- [x] done',
    });

    expect(r.isError).toBeUndefined();
    expect((r.content[0] as { text: string }).text).toBe(
      'Edit submitted. If it fails you will be woken with a system note saying why; verify structural changes with canvas_read.',
    );

    const rows = outboundActions();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('system');
    expect(rows[0].content).toMatchObject({
      action: 'canvas_edit',
      canvas_id: 'F1',
      op: 'replace_section',
      section_text: 'Tasks',
      markdown: '## Tasks\n\n- [x] done',
    });
    expect(rows[0].content.requestId).toBe(rows[0].id);
  });

  it('append needs no section_text', async () => {
    const r = await canvasUpdate.handler({ canvas_id: 'F1', op: 'append', markdown: '- [ ] new' });
    expect(r.isError).toBeUndefined();
    const rows = outboundActions();
    expect(rows[0].content).toMatchObject({ action: 'canvas_edit', op: 'append' });
    expect(rows[0].content.section_text).toBeUndefined();
  });
});

describe('canvas_read — blocking round trip', () => {
  it('requires canvas_id', async () => {
    const r = await canvasRead.handler({});
    expect(r.isError).toBe(true);
    expect(outboundActions()).toHaveLength(0);
  });

  it('submits canvas_read, polls, and returns the host-fetched text', async () => {
    const pending = canvasRead.handler({ canvas_id: 'F1', timeout: 5 });

    // Let the tool write its request row, then answer it like the host would.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rows = outboundActions();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toMatchObject({ action: 'canvas_read', canvas_id: 'F1' });
    const requestId = rows[0].content.requestId as string;
    seedCanvasResponse(requestId, { status: 'ok', result: { canvas_id: 'F1', text: '# Room\n\n- [x] done' } });

    const r = await pending;
    expect(r.isError).toBeUndefined();
    expect((r.content[0] as { text: string }).text).toBe('# Room\n\n- [x] done');

    // The response row is acked so the poll loop won't re-deliver it.
    const acked = getOutboundDb()
      .prepare('SELECT status FROM processing_ack WHERE message_id = ?')
      .get(`canvas-resp-${requestId}`) as { status: string } | null;
    expect(acked?.status).toBe('completed');
  });

  it('surfaces host-side errors as tool errors', async () => {
    const pending = canvasRead.handler({ canvas_id: 'F1', timeout: 5 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const requestId = outboundActions()[0].content.requestId as string;
    seedCanvasResponse(requestId, { status: 'error', result: { error: 'canvas_not_found' } });

    const r = await pending;
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('canvas_not_found');
  });

  it('times out when no response arrives', async () => {
    const r = await canvasRead.handler({ canvas_id: 'F1', timeout: 1 });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('timed out');
  });
});
