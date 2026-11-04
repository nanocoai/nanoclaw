/**
 * Canvas-actions tests: the safe op mapping (mocked fetch — lookup+edit
 * sequences, whole-doc replace unconstructible), token resolution, response
 * rows into inbound.db, and the HTML→text read-back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import type { MessagingGroup, Session } from '../../types.js';
import { editCanvas, htmlToReadableText, parseCanvasBlocks, resolveHeadingRegion } from './canvas-api.js';
import { handleCanvasEdit, handleCanvasRead, resolveSessionBotToken } from './handlers.js';

const { mockWriteSessionMessage } = vi.hoisted(() => ({ mockWriteSessionMessage: vi.fn() }));

vi.mock('../../session-manager.js', () => ({ writeSessionMessage: mockWriteSessionMessage }));

const NOW = new Date().toISOString();
const MG_ID = 'mg-canvas';

function makeSession(messagingGroupId: string | null = MG_ID): Session {
  return {
    id: 'sess-canvas',
    agent_group_id: 'ag-canvas',
    messaging_group_id: messagingGroupId,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: NOW,
  };
}

function makeMg(overrides: Partial<MessagingGroup> = {}): MessagingGroup {
  return {
    id: MG_ID,
    channel_type: 'slack',
    platform_id: 'slack:C0ROOM',
    instance: 'slack-pixel',
    name: 'Pixel room',
    is_group: 1,
    unknown_sender_policy: 'public',
    denied_at: null,
    created_at: NOW,
    ...overrides,
  };
}

function responseRows(): Array<{ id: string; kind: string; trigger: boolean; content: Record<string, unknown> }> {
  return mockWriteSessionMessage.mock.calls.map((call) => {
    const row = call[2] as { id: string; kind: string; trigger: boolean; content: string };
    return { ...row, content: JSON.parse(row.content) };
  });
}

/** The chat-note text of an edit-outcome row (canvas_edit notes are kind='chat'). */
function editNoteText(row: { kind: string; content: Record<string, unknown> }): string {
  expect(row.kind).toBe('chat');
  return row.content.text as string;
}

function slackJson(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const fetchMock = vi.fn();

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await createMessagingGroup(makeMg());
  mockWriteSessionMessage.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  process.env.SLACK_BOT_TOKEN_PIXEL = 'xoxb-pixel-token';
});

afterEach(async () => {
  delete process.env.SLACK_BOT_TOKEN_PIXEL;
  vi.unstubAllGlobals();
  await closeDb();
});

describe('resolveSessionBotToken', () => {
  it('maps the mg instance to its .env token key', async () => {
    expect(await resolveSessionBotToken(makeSession())).toEqual({ token: 'xoxb-pixel-token' });
  });

  it('errors (naming the key, not any value) when the token is absent', async () => {
    delete process.env.SLACK_BOT_TOKEN_PIXEL;
    const result = await resolveSessionBotToken(makeSession());
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('SLACK_BOT_TOKEN_PIXEL');
  });

  it('rejects sessions with no messaging group and non-Slack channels', async () => {
    expect(await resolveSessionBotToken(makeSession(null))).toHaveProperty('error');
    await createMessagingGroup(
      makeMg({ id: 'mg-tg', channel_type: 'telegram', platform_id: 'tg:1', instance: 'telegram' }),
    );
    expect(await resolveSessionBotToken({ ...makeSession(), messaging_group_id: 'mg-tg' })).toHaveProperty('error');
  });
});

describe('handleCanvasEdit', () => {
  it('append maps to a single insert_at_end canvases.edit (no lookup)', async () => {
    fetchMock.mockResolvedValueOnce(slackJson({ ok: true }));

    await handleCanvasEdit(
      { action: 'canvas_edit', requestId: 'req-1', canvas_id: 'F0C', op: 'append', markdown: '- [ ] new task' },
      makeSession(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://slack.com/api/canvases.edit');
    const body = JSON.parse(init.body as string);
    expect(body.canvas_id).toBe('F0C');
    expect(body.changes).toEqual([
      { operation: 'insert_at_end', document_content: { type: 'markdown', markdown: '- [ ] new task' } },
    ]);

    const rows = responseRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('canvas-resp-req-1');
    expect(rows[0].trigger).toBe(false);
    expect(editNoteText(rows[0])).toContain('Canvas edit applied');
  });

  it('replace_section falls back to sections.lookup when the HTML read-back fails', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('offline')) // files.info → no read-back
      .mockResolvedValueOnce(slackJson({ ok: true, sections: [{ id: 'temp:C:SEC1' }] }))
      .mockResolvedValueOnce(slackJson({ ok: true }));

    await handleCanvasEdit(
      {
        action: 'canvas_edit',
        requestId: 'req-2',
        canvas_id: 'F0C',
        op: 'replace_section',
        section_text: 'Tasks',
        markdown: '## Tasks\n\n- [x] done',
      },
      makeSession(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [lookupUrl, lookupInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(lookupUrl).toBe('https://slack.com/api/canvases.sections.lookup');
    expect(JSON.parse(lookupInit.body as string)).toEqual({
      canvas_id: 'F0C',
      criteria: { contains_text: 'Tasks' },
    });
    const [, editInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    const editBody = JSON.parse(editInit.body as string);
    expect(editBody.changes).toEqual([
      {
        operation: 'replace',
        section_id: 'temp:C:SEC1',
        document_content: { type: 'markdown', markdown: '## Tasks\n\n- [x] done' },
      },
    ]);
    expect(editNoteText(responseRows()[0])).toContain('Canvas edit applied');
  });

  it('insert_after_section falls back to insert_after with the looked-up id when the read-back fails', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(slackJson({ ok: true, sections: [{ id: 'temp:C:SEC9' }] }))
      .mockResolvedValueOnce(slackJson({ ok: true }));

    await handleCanvasEdit(
      {
        action: 'canvas_edit',
        requestId: 'req-3',
        canvas_id: 'F0C',
        op: 'insert_after_section',
        section_text: 'Decisions',
        markdown: '> We ship MPIM rooms.',
      },
      makeSession(),
    );

    const [, editInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(editInit.body as string).changes[0]).toMatchObject({
      operation: 'insert_after',
      section_id: 'temp:C:SEC9',
    });
  });

  it('replace_section WITHOUT section_text fails before any Slack call — whole-doc replace is impossible', async () => {
    await handleCanvasEdit(
      { action: 'canvas_edit', requestId: 'req-4', canvas_id: 'F0C', op: 'replace_section', markdown: 'boom' },
      makeSession(),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    const rows = responseRows();
    expect(rows[0].trigger).toBe(true);
    const note4 = editNoteText(rows[0]);
    expect(note4).toContain('Canvas edit FAILED');
    expect(note4).toContain('section_text');
  });

  it('a lookup with no match errors without ever calling canvases.edit', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('offline')) // files.info → no read-back
      .mockResolvedValueOnce(slackJson({ ok: true, sections: [] }));

    await handleCanvasEdit(
      {
        action: 'canvas_edit',
        requestId: 'req-5',
        canvas_id: 'F0C',
        op: 'replace_section',
        section_text: 'Nonexistent',
        markdown: 'x',
      },
      makeSession(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2); // failed files.info + lookup only
    const rows = responseRows();
    expect(rows[0].trigger).toBe(true);
    expect(editNoteText(rows[0])).toContain('Nonexistent');
  });

  it('a Slack API error becomes a triggering error row', async () => {
    fetchMock.mockResolvedValueOnce(slackJson({ ok: false, error: 'canvas_not_found' }));

    await handleCanvasEdit(
      { action: 'canvas_edit', requestId: 'req-6', canvas_id: 'F0C', op: 'append', markdown: 'x' },
      makeSession(),
    );

    const rows = responseRows();
    expect(rows[0].trigger).toBe(true);
    expect(editNoteText(rows[0])).toContain('canvas_not_found');
  });

  it('editCanvas refuses a sectioned op with an empty section id (belt and braces)', async () => {
    await expect(editCanvas('xoxb-t', 'F0C', { operation: 'replace', sectionId: '', markdown: 'x' })).rejects.toThrow(
      /without a resolved section_id/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('duplicate-heading guard (B4)', () => {
  /** files.info + HTML download pair for a canvas whose read-back has the given body. */
  function mockReadBack(html: string): void {
    fetchMock
      .mockResolvedValueOnce(
        slackJson({ ok: true, file: { id: 'F0C', url_private_download: 'https://files.slack.com/canvas.html' } }),
      )
      .mockResolvedValueOnce(new Response(html, { status: 200 }));
  }

  it('insert_after_section with a duplicate first heading is refused before any lookup/edit', async () => {
    mockReadBack('<h1 id="temp:C:A">Room</h1><h2 id="temp:C:B">Tasks</h2><p>- [ ] x</p>');

    await handleCanvasEdit(
      {
        action: 'canvas_edit',
        requestId: 'req-g1',
        canvas_id: 'F0C',
        op: 'insert_after_section',
        section_text: 'Room',
        markdown: '## Tasks\n\n- [x] done',
      },
      makeSession(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2); // files.info + download only — no lookup, no edit
    const rows = responseRows();
    expect(rows[0].trigger).toBe(true);
    const guardNote = editNoteText(rows[0]);
    expect(guardNote).toContain('Canvas edit FAILED');
    expect(guardNote).toContain('replace_section');
    expect(guardNote).toContain('Tasks');
  });

  it('matches case-insensitively and trimmed', async () => {
    mockReadBack('<h2 id="temp:C:B">Tasks</h2>');

    await handleCanvasEdit(
      {
        action: 'canvas_edit',
        requestId: 'req-g2',
        canvas_id: 'F0C',
        op: 'append',
        markdown: '##   tasks  \n\n- [ ] again',
      },
      makeSession(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(editNoteText(responseRows()[0])).toContain('Canvas edit FAILED');
  });

  it('a non-duplicate heading passes through — region path, no lookup needed', async () => {
    mockReadBack('<h2 id="temp:C:B">Tasks</h2>');
    fetchMock.mockResolvedValueOnce(slackJson({ ok: true }));

    await handleCanvasEdit(
      {
        action: 'canvas_edit',
        requestId: 'req-g3',
        canvas_id: 'F0C',
        op: 'insert_after_section',
        section_text: 'Tasks',
        markdown: '## Retro notes\n\n- went well',
      },
      makeSession(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(3); // files.info, download, edit — section id from the read-back
    const [editUrl, editInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(editUrl).toBe('https://slack.com/api/canvases.edit');
    expect(JSON.parse(editInit.body as string).changes[0]).toMatchObject({
      operation: 'insert_after',
      section_id: 'temp:C:B',
    });
    expect(editNoteText(responseRows()[0])).toContain('Canvas edit applied');
  });

  it('a failed read-back never blocks the edit (guard is best-effort)', async () => {
    fetchMock
      .mockResolvedValueOnce(slackJson({ ok: false, error: 'file_not_found' })) // files.info fails
      .mockResolvedValueOnce(slackJson({ ok: true, sections: [{ id: 'temp:C:SEC1' }] }))
      .mockResolvedValueOnce(slackJson({ ok: true }));

    await handleCanvasEdit(
      {
        action: 'canvas_edit',
        requestId: 'req-g4',
        canvas_id: 'F0C',
        op: 'insert_after_section',
        section_text: 'Tasks',
        markdown: '## Tasks\n\n- [x] done',
      },
      makeSession(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(3); // files.info (failed), lookup, edit
    expect(editNoteText(responseRows()[0])).toContain('Canvas edit applied');
  });

  it('markdown without a heading skips the read-back entirely', async () => {
    fetchMock.mockResolvedValueOnce(slackJson({ ok: true }));

    await handleCanvasEdit(
      { action: 'canvas_edit', requestId: 'req-g5', canvas_id: 'F0C', op: 'append', markdown: '- [ ] plain item' },
      makeSession(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1); // straight to canvases.edit
    expect(editNoteText(responseRows()[0])).toContain('Canvas edit applied');
  });

  it('replace_section is exempt — replacing a section with its own heading is the point', async () => {
    mockReadBack('<h2 id="temp:C:B">Tasks</h2><p id="temp:C:P1" class="line">- [ ] old</p>');
    fetchMock
      .mockResolvedValueOnce(slackJson({ ok: true })) // replace heading
      .mockResolvedValueOnce(slackJson({ ok: true })); // delete old body

    await handleCanvasEdit(
      {
        action: 'canvas_edit',
        requestId: 'req-g6',
        canvas_id: 'F0C',
        op: 'replace_section',
        section_text: 'Tasks',
        markdown: '## Tasks\n\n- [x] done',
      },
      makeSession(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(4); // files.info, download, replace, delete — no refusal
    expect(editNoteText(responseRows()[0])).toContain('Canvas edit applied');
  });
});

describe('heading-region ops (Slack sections are blocks, not regions)', () => {
  /** Trimmed from the live canvas HTML that produced the duplicated-section bug. */
  const REGION_HTML =
    '<div class="quip-canvas-content">' +
    '<h2 id="temp:C:NOTES">Notes</h2>' +
    '<h2 id="temp:C:OQ">Open Questions</h2>' +
    '<p id="temp:C:P1" class="line">Questions that need answers:</p>' +
    "<div data-section-style='5'><ul id='temp:C:L1'><li id='temp:C:LI1'><span id=\"temp:C:LI1\">item</span></li></ul></div>" +
    '<p id="temp:C:NB" class="line"><i>Working notes</i></p>' +
    '</div>';

  function mockReadBack(html: string): void {
    fetchMock
      .mockResolvedValueOnce(
        slackJson({ ok: true, file: { id: 'F0C', url_private_download: 'https://files.slack.com/canvas.html' } }),
      )
      .mockResolvedValueOnce(new Response(html, { status: 200 }));
  }

  function editBodies(fromCall: number): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
      .slice(fromCall)
      .map((c) => JSON.parse((c as [string, RequestInit])[1].body as string).changes[0] as Record<string, unknown>);
  }

  it('replace_section replaces the heading block then deletes every old body block, one call each', async () => {
    mockReadBack(REGION_HTML);
    fetchMock
      .mockResolvedValueOnce(slackJson({ ok: true })) // replace temp:C:OQ
      .mockResolvedValueOnce(slackJson({ ok: true })) // delete temp:C:P1
      .mockResolvedValueOnce(slackJson({ ok: true })) // delete temp:C:L1
      .mockResolvedValueOnce(slackJson({ ok: true })); // delete temp:C:NB

    await handleCanvasEdit(
      {
        action: 'canvas_edit',
        requestId: 'req-h1',
        canvas_id: 'F0C',
        op: 'replace_section',
        section_text: 'Open Questions',
        markdown: '## Open Questions\n\n- new list',
      },
      makeSession(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(6);
    const changes = editBodies(2);
    expect(changes[0]).toMatchObject({ operation: 'replace', section_id: 'temp:C:OQ' });
    expect(changes.slice(1)).toEqual([
      { operation: 'delete', section_id: 'temp:C:P1' },
      { operation: 'delete', section_id: 'temp:C:LI1' },
      { operation: 'delete', section_id: 'temp:C:NB' },
    ]);
    expect(editNoteText(responseRows()[0])).toContain('Canvas edit applied');
  });

  it('insert_after_section lands after the LAST block of the region, not the heading', async () => {
    mockReadBack(REGION_HTML);
    fetchMock.mockResolvedValueOnce(slackJson({ ok: true }));

    await handleCanvasEdit(
      {
        action: 'canvas_edit',
        requestId: 'req-h2',
        canvas_id: 'F0C',
        op: 'insert_after_section',
        section_text: 'Open Questions',
        markdown: 'A follow-up paragraph.',
      },
      makeSession(),
    );

    expect(editBodies(2)[0]).toMatchObject({ operation: 'insert_after', section_id: 'temp:C:NB' });
  });

  it('an empty region (heading directly followed by another heading) targets the heading itself', async () => {
    mockReadBack(REGION_HTML);
    fetchMock.mockResolvedValueOnce(slackJson({ ok: true }));

    await handleCanvasEdit(
      {
        action: 'canvas_edit',
        requestId: 'req-h3',
        canvas_id: 'F0C',
        op: 'insert_after_section',
        section_text: 'Notes',
        markdown: 'Right under the Notes heading.',
      },
      makeSession(),
    );

    expect(editBodies(2)[0]).toMatchObject({ operation: 'insert_after', section_id: 'temp:C:NOTES' });
  });

  it('a mid-sequence delete failure reports a partial apply (new content in, leftovers named)', async () => {
    mockReadBack(REGION_HTML);
    fetchMock
      .mockResolvedValueOnce(slackJson({ ok: true })) // replace ok
      .mockResolvedValueOnce(slackJson({ ok: false, error: 'section_not_found' })); // first delete fails

    await handleCanvasEdit(
      {
        action: 'canvas_edit',
        requestId: 'req-h4',
        canvas_id: 'F0C',
        op: 'replace_section',
        section_text: 'Open Questions',
        markdown: '## Open Questions\n\n- new list',
      },
      makeSession(),
    );

    const rows = responseRows();
    expect(rows[0].trigger).toBe(true);
    const partialNote = editNoteText(rows[0]);
    expect(partialNote).toContain('partially applied');
    expect(partialNote).toContain('3 old block(s)');
  });
});

describe('checklist tick-state platform limit', () => {
  it('counts ticked items in the region and warns on rewrite (state is UI-only)', async () => {
    // Live checklist with one ticked item (li class='checked').
    fetchMock
      .mockResolvedValueOnce(
        slackJson({ ok: true, file: { id: 'F0C', url_private_download: 'https://files.slack.com/canvas.html' } }),
      )
      .mockResolvedValueOnce(
        new Response(
          '<h2 id="temp:C:T">Tasks</h2>' +
            "<div data-section-style='7'><ul id='temp:C:U'>" +
            "<li id='temp:C:SA' class='checked' value='1'><span id=\"temp:C:SA\">done one</span></li>" +
            '<li id=\'temp:C:SB\'><span id="temp:C:SB">open one</span></li>' +
            '</ul></div>',
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(slackJson({ ok: true })) // replace heading
      .mockResolvedValueOnce(slackJson({ ok: true })) // delete SA
      .mockResolvedValueOnce(slackJson({ ok: true })); // delete SB

    await handleCanvasEdit(
      {
        action: 'canvas_edit',
        requestId: 'req-t1',
        canvas_id: 'F0C',
        op: 'replace_section',
        section_text: 'Tasks',
        markdown: '## Tasks\n\n- [x] done one\n- [ ] open one\n- [ ] new one',
      },
      makeSession(),
    );

    const rows = responseRows();
    expect(rows[0].trigger).toBe(true); // warning must wake the agent
    const note = editNoteText(rows[0]);
    expect(note).toContain('Canvas edit applied');
    expect(note).toContain('[x] states in your markdown were NOT applied');
    expect(note).toContain('1 ticked item(s)');
  });

  it('a rewrite of an untick-free checklist without [x] markdown stays a silent success', async () => {
    fetchMock
      .mockResolvedValueOnce(
        slackJson({ ok: true, file: { id: 'F0C', url_private_download: 'https://files.slack.com/canvas.html' } }),
      )
      .mockResolvedValueOnce(
        new Response(
          '<h2 id="temp:C:T">Tasks</h2>' +
            "<div data-section-style='7'><ul id='temp:C:U'><li id='temp:C:SB'><span id=\"temp:C:SB\">open one</span></li></ul></div>",
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(slackJson({ ok: true }))
      .mockResolvedValueOnce(slackJson({ ok: true }));

    await handleCanvasEdit(
      {
        action: 'canvas_edit',
        requestId: 'req-t2',
        canvas_id: 'F0C',
        op: 'replace_section',
        section_text: 'Tasks',
        markdown: '## Tasks\n\n- [ ] open one\n- [ ] new one',
      },
      makeSession(),
    );

    const rows = responseRows();
    expect(rows[0].trigger).toBe(false);
    expect(editNoteText(rows[0])).toContain('Canvas edit applied');
  });
});

describe('htmlToReadableText checklists', () => {
  it('renders live-export checklist items as [x]/[ ] from li class, not inputs', () => {
    const html =
      '<h2 id="temp:C:T">Tasks</h2>' +
      '<div data-section-style=\'7\' class="list-numbering-restart-at" style="--indent0: 0">' +
      "<ul id='temp:C:U'>" +
      "<li id='temp:C:LA' class='checked' value='1'><span id=\"temp:C:LA\">Draft launch checklist</span><br/></li>" +
      '<li id=\'temp:C:LB\'><span id="temp:C:LB">Verify canvas scopes</span><br/></li>' +
      '</ul></div>';
    const text = htmlToReadableText(html);
    expect(text).toContain('- [x] Draft launch checklist');
    expect(text).toContain('- [ ] Verify canvas scopes');
  });

  it('plain lists keep plain bullets', () => {
    const html =
      "<div data-section-style='5'><ul id='temp:C:U'><li id='temp:C:L'><span>plain item</span></li></ul></div>";
    const text = htmlToReadableText(html);
    expect(text).toContain('- plain item');
    expect(text).not.toContain('[ ]');
  });
});

describe('handleCanvasRead', () => {
  it('fetches files.info, downloads the HTML, and returns stripped text without waking', async () => {
    fetchMock
      .mockResolvedValueOnce(
        slackJson({ ok: true, file: { id: 'F0C', url_private_download: 'https://files.slack.com/canvas.html' } }),
      )
      .mockResolvedValueOnce(
        new Response('<h1 id="temp:C:X">Room</h1><ul><li><input type="checkbox" checked>done</li></ul>', {
          status: 200,
        }),
      );

    await handleCanvasRead({ action: 'canvas_read', requestId: 'req-r1', canvas_id: 'F0C' }, makeSession());

    const [infoUrl] = fetchMock.mock.calls[0] as [string];
    expect(infoUrl).toBe('https://slack.com/api/files.info?file=F0C');
    const [dlUrl, dlInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(dlUrl).toBe('https://files.slack.com/canvas.html');
    expect((dlInit.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-pixel-token');

    const rows = responseRows();
    expect(rows[0].trigger).toBe(false);
    expect(rows[0].content).toMatchObject({ type: 'canvas_response', requestId: 'req-r1', status: 'ok' });
    const text = (rows[0].content.result as { text: string }).text;
    expect(text).toContain('# Room');
    expect(text).toContain('- [x] done');
    expect(text).not.toContain('temp:C:X');
  });

  it('read failures come back without waking (the tool is polling)', async () => {
    fetchMock.mockResolvedValueOnce(slackJson({ ok: false, error: 'file_not_found' }));

    await handleCanvasRead({ action: 'canvas_read', requestId: 'req-r2', canvas_id: 'F0C' }, makeSession());

    const rows = responseRows();
    expect(rows[0].trigger).toBe(false);
    expect(rows[0].content).toMatchObject({ status: 'error' });
    expect((rows[0].content.result as { error: string }).error).toContain('file_not_found');
  });
});

describe('htmlToReadableText', () => {
  it('keeps heading levels, bullets, checkboxes, and table pipes; drops tags and entities', () => {
    const html =
      '<style>.x{}</style><h1 id="temp:C:A">Title</h1><h2 id="temp:C:B">Tasks</h2>' +
      '<ul><li><input type="checkbox">open item</li><li><input type="checkbox" checked>closed item</li></ul>' +
      '<table><tr><td>a &amp; b</td><td>c</td></tr></table><p>tail &lt;ok&gt;</p>';
    const text = htmlToReadableText(html);
    expect(text).toContain('# Title');
    expect(text).toContain('## Tasks');
    expect(text).toContain('- [ ] open item');
    expect(text).toContain('- [x] closed item');
    expect(text).toContain('a & b | c |');
    expect(text).toContain('tail <ok>'); // entities decode after tag stripping
    expect(text).not.toContain('<h1');
    expect(text).not.toContain('<style>');
    expect(text).not.toContain('temp:C:');
  });

  it('caps at maxChars with a truncation note (via fetchCanvasText cap path)', () => {
    // The cap lives in fetchCanvasText; here just sanity-check big input survives stripping.
    const text = htmlToReadableText(`<p>${'x'.repeat(10_000)}</p>`);
    expect(text.length).toBe(10_000);
  });
});

describe('parseCanvasBlocks / resolveHeadingRegion', () => {
  it('parses top-level blocks in order, folding nested structure into its outermost block', () => {
    const html =
      '<div class="quip-canvas-content">' +
      '<h1 id="temp:C:T">Q&amp;A Room</h1>' +
      '<blockquote><p id="temp:C:BQ" class="line">purpose line</p></blockquote>' +
      '<h2 id="temp:C:M">Members</h2>' +
      '<table><tr><td><p id="temp:C:CELL" class="line">cell</p></td></tr></table>' +
      '<h2 id="temp:C:TK">Tasks</h2>' +
      "<div data-section-style='7'><ul id='temp:C:UL'><li id='temp:C:LI'><span>item</span><ul><li>nested</li></ul></li></ul></div>" +
      '<p id="temp:C:TAIL" class="line">tail</p>' +
      '</div>';
    const blocks = parseCanvasBlocks(html);
    expect(blocks.map((b) => `${b.tag}:${b.id}`)).toEqual([
      'h1:temp:C:T',
      'blockquote:temp:C:BQ', // quote addressed via its inner <p> id
      'h2:temp:C:M',
      'table:null', // cell paragraphs fold into the table block
      'h2:temp:C:TK',
      'ul:temp:C:UL', // nested list folds into the outermost ul
      'p:temp:C:TAIL',
    ]);
    expect(blocks[0].text).toBe('Q&A Room'); // heading text entity-decoded, tag-stripped
  });

  it('resolves a heading region: exact match wins, body stops at the next heading', () => {
    const html =
      '<h2 id="temp:C:A">Notes</h2><p id="temp:C:P" class="line">body</p>' +
      "<ul id='temp:C:U'><li id='temp:C:LX'><span id=\"temp:C:SX\">x</span></li></ul>" +
      '<h2 id="temp:C:B">Notes archive</h2><p id="temp:C:Q">other</p>';
    const region = resolveHeadingRegion(html, 'Notes');
    expect(region).toEqual({
      headingId: 'temp:C:A',
      bodyIds: ['temp:C:P', 'temp:C:SX'],
      lastId: 'temp:C:SX',
      hasUnaddressableBlocks: false,
      checkedItemCount: 0,
    });
  });

  it('lists resolve to their item span ids — the ul wrapper id is a canvases.edit no-op (live-observed)', () => {
    // The live checklist export shape: styled wrapper div, one ul per item,
    // item text in an id-bearing span. Deleting the ul id silently no-ops
    // (ok:true, canvas unchanged) — the region must carry the span ids.
    const html =
      '<h2 id="temp:C:T">Tasks</h2>' +
      "<div data-section-style='7'><ul id='temp:C:U1'><li id='temp:C:LA'><span id=\"temp:C:SA\">Draft launch checklist</span></li></ul>" +
      "<ul id='temp:C:U2'><li id='temp:C:LB'><span id=\"temp:C:SB\">Verify canvas scopes</span></li></ul></div>" +
      '<h2 id="temp:C:D">Decisions</h2>';
    const region = resolveHeadingRegion(html, 'Tasks');
    expect(region).toEqual({
      headingId: 'temp:C:T',
      bodyIds: ['temp:C:SA', 'temp:C:SB'],
      lastId: 'temp:C:SB',
      hasUnaddressableBlocks: false,
      checkedItemCount: 0,
    });
  });

  it('a list without item span ids is flagged unaddressable, not deleted by wrapper id', () => {
    const html = '<h2 id="temp:C:A">Tasks</h2><ul id=\'temp:C:U\'><li>x</li></ul><p id="temp:C:P">tail</p>';
    const region = resolveHeadingRegion(html, 'Tasks');
    expect(region?.bodyIds).toEqual(['temp:C:P']);
    expect(region?.hasUnaddressableBlocks).toBe(true);
  });

  it('flags unaddressable body blocks (an id-less table) and falls back to contains-match', () => {
    const html = '<h2 id="temp:C:A">Member Roster</h2><table><tr><td>x</td></tr></table><p id="temp:C:P">tail</p>';
    const region = resolveHeadingRegion(html, 'roster');
    expect(region?.headingId).toBe('temp:C:A');
    expect(region?.bodyIds).toEqual(['temp:C:P']);
    expect(region?.hasUnaddressableBlocks).toBe(true);
  });

  it('returns null when no heading matches (caller falls back to sections.lookup)', () => {
    expect(resolveHeadingRegion('<h2 id="temp:C:A">Tasks</h2>', 'Decisions')).toBeNull();
    expect(resolveHeadingRegion('<p id="temp:C:P">Decisions happen here</p>', 'Decisions')).toBeNull();
  });
});
