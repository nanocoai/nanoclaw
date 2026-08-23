/**
 * Maintenance Coordinator's live Trello read tools. Two concerns tested
 * here: (1) self-gating to Maintenance Coordinator's own agent group,
 * since these tools have no host round trip to validate the caller the
 * way every fire-and-forget tool in the sibling module does; (2) correct
 * use of trelloGet (the GET-only chokepoint) with default exclusion of
 * archived/closed cards.
 *
 * Deliberately does NOT mock the `fs` or `./trello-read-client.js`
 * modules -- bun's module registry is process-wide across a whole `bun
 * test` run, not scoped per file, so replacing a module every other test
 * file also depends on (like `fs`) breaks unrelated tests elsewhere.
 * Instead: stub `globalThis.fetch` (safe, local, restored per test, same
 * technique trello-read-client.test.ts uses) and write a REAL
 * /workspace/agent/container.json in this disposable test container.
 *
 * Ported verbatim from old commit 824318ff -- no DB access, no
 * adaptation needed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { listTrelloBoards, getTrelloBoard, searchTrelloCards, getTrelloCard } from './maintenance-trello-read.js';

const MC_AGENT_GROUP_ID = 'ag-0bed629f-db95-4547-bd12-41eea5e6fbe5';
const OTHER_AGENT_GROUP_ID = 'ag-some-other-agent';
const CONFIG_DIR = '/workspace/agent';
const CONFIG_PATH = path.join(CONFIG_DIR, 'container.json');

let fetchCalls: { url: string; init: RequestInit | undefined }[] = [];
let originalFetch: typeof fetch;
let hadExistingConfig = false;
let existingConfigBackup = '';

function stubFetch(body: unknown = {}, ok = true, status = 200): void {
  fetchCalls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: input.toString(), init });
    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'Error',
      json: async () => body,
    } as Response;
  }) as typeof fetch;
}

function writeContainerConfig(agentGroupId: string | undefined): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (agentGroupId === undefined) {
    fs.rmSync(CONFIG_PATH, { force: true });
    return;
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ agentGroupId }));
}

function text(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? '';
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  hadExistingConfig = fs.existsSync(CONFIG_PATH);
  if (hadExistingConfig) existingConfigBackup = fs.readFileSync(CONFIG_PATH, 'utf8');
  writeContainerConfig(MC_AGENT_GROUP_ID);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (hadExistingConfig) {
    fs.writeFileSync(CONFIG_PATH, existingConfigBackup);
  } else {
    fs.rmSync(CONFIG_PATH, { force: true });
  }
});

describe('self-gating to Maintenance Coordinator only', () => {
  it('list_trello_boards refuses when the container belongs to a different agent group', async () => {
    writeContainerConfig(OTHER_AGENT_GROUP_ID);
    stubFetch([]);
    const result = await listTrelloBoards.handler({});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not permitted');
    expect(fetchCalls).toHaveLength(0);
  });

  it('search_trello_cards refuses when container.json is unreadable/missing', async () => {
    writeContainerConfig(undefined);
    stubFetch({ cards: [] });
    const result = await searchTrelloCards.handler({ query: '115 Edgewood' });
    expect(result.isError).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });

  it('get_trello_board proceeds for Maintenance Coordinator itself', async () => {
    stubFetch({ id: 'b1', name: 'Properties', lists: [], cards: [] });
    const result = await getTrelloBoard.handler({ board_id: 'b1' });
    expect(result.isError).toBeUndefined();
    expect(fetchCalls).toHaveLength(1);
  });
});

describe('list_trello_boards', () => {
  it('excludes closed boards by default', async () => {
    stubFetch([
      { id: '1', name: 'Properties', closed: false },
      { id: '2', name: 'Old Board', closed: true },
    ]);
    const result = await listTrelloBoards.handler({});
    expect(text(result)).toContain('Properties');
    expect(text(result)).not.toContain('Old Board');
  });

  it('includes closed boards when explicitly requested', async () => {
    stubFetch([{ id: '2', name: 'Old Board', closed: true }]);
    const result = await listTrelloBoards.handler({ include_closed: true });
    expect(text(result)).toContain('Old Board');
    expect(text(result)).toContain('[closed]');
  });
});

describe('get_trello_board', () => {
  it('requires board_id', async () => {
    stubFetch({});
    const result = await getTrelloBoard.handler({});
    expect(result.isError).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });

  it('calls the boards endpoint with the given id', async () => {
    stubFetch({
      id: 'b1',
      name: 'Properties',
      lists: [{ id: 'l1', name: '115 Edgewood' }],
      cards: [{ id: 'c1', name: 'Fix leak', idList: 'l1', due: null, dateLastActivity: '2026-08-01T00:00:00Z' }],
    });
    const result = await getTrelloBoard.handler({ board_id: 'b1' });
    expect(fetchCalls[0].url).toContain('/1/boards/b1');
    expect(text(result)).toContain('Fix leak');
    expect(text(result)).toContain('115 Edgewood');
  });
});

describe('search_trello_cards', () => {
  it('requires query', async () => {
    stubFetch({});
    const result = await searchTrelloCards.handler({});
    expect(result.isError).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });

  it('searches via /1/search across all boards by default (no board scoping)', async () => {
    stubFetch({ cards: [] });
    await searchTrelloCards.handler({ query: '115 Edgewood' });
    expect(fetchCalls[0].url).toContain('/1/search');
    expect(fetchCalls[0].url).toContain('query=115+Edgewood');
  });

  it('scopes to one board when board_id is given', async () => {
    stubFetch({ cards: [] });
    await searchTrelloCards.handler({ query: 'leak', board_id: 'b1' });
    expect(decodeURIComponent(fetchCalls[0].url)).toContain('board:b1');
  });

  it('excludes closed/archived cards by default', async () => {
    stubFetch({
      cards: [
        { id: 'c1', name: 'Open card', desc: '', due: null, dateLastActivity: '', idBoard: 'b1', idList: 'l1', closed: false, labels: [] },
        { id: 'c2', name: 'Archived card', desc: '', due: null, dateLastActivity: '', idBoard: 'b1', idList: 'l1', closed: true, labels: [] },
      ],
    });
    const result = await searchTrelloCards.handler({ query: 'x' });
    expect(text(result)).toContain('Open card');
    expect(text(result)).not.toContain('Archived card');
  });

  it('includes closed/archived cards when explicitly requested', async () => {
    stubFetch({
      cards: [{ id: 'c2', name: 'Archived card', desc: '', due: null, dateLastActivity: '', idBoard: 'b1', idList: 'l1', closed: true, labels: [] }],
    });
    const result = await searchTrelloCards.handler({ query: 'x', include_completed: true });
    expect(text(result)).toContain('Archived card');
  });

  it('reports no matches plainly rather than an empty/blank reply', async () => {
    stubFetch({ cards: [] });
    const result = await searchTrelloCards.handler({ query: 'nonexistent' });
    expect(text(result)).toContain('No matching cards');
  });

  it('requests board/list/member enrichment via card_board/card_list/card_members', async () => {
    stubFetch({ cards: [] });
    await searchTrelloCards.handler({ query: 'Wilfred Ave' });
    const url = decodeURIComponent(fetchCalls[0].url);
    expect(url).toContain('card_board=true');
    expect(url).toContain('card_list=true');
    expect(url).toContain('card_members=true');
  });

  it('regression: results are enriched with resolved board name, list name, members, and labels -- not just raw idBoard/idList', async () => {
    stubFetch({
      cards: [
        {
          id: 'c1',
          name: '313 Wilfred ave',
          desc: '',
          due: null,
          dateLastActivity: '',
          idBoard: 'b-raw-id-should-not-be-the-only-info',
          idList: 'l-raw-id-should-not-be-the-only-info',
          closed: false,
          labels: [{ name: 'Important' }],
          board: { name: 'Properties' },
          list: { name: 'Apartments to Get Ready' },
          members: [{ fullName: 'Haskel Harrison' }, { fullName: 'Elehazar Villeda' }],
        },
      ],
    });
    const result = await searchTrelloCards.handler({ query: 'Wilfred Ave' });
    const t = text(result);
    expect(t).toContain('Properties');
    expect(t).toContain('Apartments to Get Ready');
    expect(t).toContain('Haskel Harrison');
    expect(t).toContain('Elehazar Villeda');
    expect(t).toContain('Important');
  });

  it('falls back to raw board id (never throws or omits the card) when Trello does not return a resolved board/list/members', async () => {
    stubFetch({
      cards: [{ id: 'c1', name: 'Unresolved card', desc: '', due: null, dateLastActivity: '', idBoard: 'b1', idList: 'l1', closed: false }],
    });
    const result = await searchTrelloCards.handler({ query: 'x' });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('Unresolved card');
    expect(text(result)).toContain('b1');
  });
});

describe('get_trello_card', () => {
  it('requires card_id', async () => {
    stubFetch({});
    const result = await getTrelloCard.handler({});
    expect(result.isError).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });

  it('surfaces board, list, description, checklist, comments, attachments, due date, and members', async () => {
    stubFetch({
      id: 'c1',
      name: '115 Edgewood Apt A',
      desc: 'Bathroom leak',
      due: '2026-09-01T00:00:00Z',
      dateLastActivity: '2026-08-01T00:00:00Z',
      idList: 'l1',
      idBoard: 'b1',
      board: { name: 'Properties' },
      list: { name: 'Apartments to Get Ready' },
      checklists: [{ name: 'Steps', checkItems: [{ name: 'Turn off water', state: 'complete' }] }],
      actions: [{ data: { text: 'Fixed the valve' }, memberCreator: { fullName: 'Elehazar' }, date: '2026-08-02T00:00:00Z' }],
      attachments: [{ name: 'photo.jpg', url: 'https://example.com/photo.jpg' }],
      members: [{ fullName: 'Elehazar' }],
      labels: [{ name: 'Important' }],
    });
    const result = await getTrelloCard.handler({ card_id: 'c1' });
    const t = text(result);
    expect(t).toContain('Properties');
    expect(t).toContain('Apartments to Get Ready');
    expect(t).toContain('Bathroom leak');
    expect(t).toContain('Turn off water');
    expect(t).toContain('Fixed the valve');
    expect(t).toContain('photo.jpg');
    expect(t).toContain('2026-09-01');
    expect(t).toContain('Elehazar');
    expect(t).toContain('Important');
  });

  it('requests labels via the fields param -- confirmed live: a separate labels=true/all include flag alone does not attach the labels array', async () => {
    stubFetch({ id: 'c1', name: 'x', desc: '', due: null, dateLastActivity: '', idList: 'l1', idBoard: 'b1' });
    await getTrelloCard.handler({ card_id: 'c1' });
    expect(decodeURIComponent(fetchCalls[0].url)).toContain('fields=name,desc,due,dateLastActivity,idList,idBoard,labels');
  });

  it('requests board/list names via separate list=true/board=true params, not via fields -- confirmed live: listing "list"/"board" in fields returns neither key', async () => {
    stubFetch({ id: 'c1', name: 'x', desc: '', due: null, dateLastActivity: '', idList: 'l1', idBoard: 'b1' });
    await getTrelloCard.handler({ card_id: 'c1' });
    const url = decodeURIComponent(fetchCalls[0].url);
    expect(url).toContain('list=true');
    expect(url).toContain('board=true');
  });

  it('regression: raw idList/idBoard are not the only board/list information surfaced -- resolved names are used when present', async () => {
    stubFetch({
      id: 'c1',
      name: '313 Wilfred ave',
      desc: '',
      due: null,
      dateLastActivity: '',
      idList: 'l-raw-id-should-not-appear-alone',
      idBoard: 'b-raw-id-should-not-appear-alone',
      board: { name: 'Properties' },
      list: { name: 'Apartments to Get Ready' },
    });
    const result = await getTrelloCard.handler({ card_id: 'c1' });
    const t = text(result);
    expect(t).toContain('Board: Properties');
    expect(t).toContain('List: Apartments to Get Ready');
  });

  it('falls back to the raw id (never throws or omits the line) when Trello does not return a resolved board/list name', async () => {
    stubFetch({ id: 'c1', name: 'Unresolved card', desc: '', due: null, dateLastActivity: '', idList: 'l1', idBoard: 'b1' });
    const result = await getTrelloCard.handler({ card_id: 'c1' });
    const t = text(result);
    expect(result.isError).toBeUndefined();
    expect(t).toContain('Board:');
    expect(t).toContain('List:');
    expect(t).toContain('b1');
    expect(t).toContain('l1');
  });

  it('regression: all nested arrays omitted (real Trello shape for a plain card) never throws', async () => {
    stubFetch({ id: 'c1', name: 'Plain card', desc: '', due: null, dateLastActivity: '2026-08-01T00:00:00Z', idList: 'l1', idBoard: 'b1' });
    const result = await getTrelloCard.handler({ card_id: 'c1' });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('Plain card');
  });

  it('a card with none of the optional fields still returns useful basic detail rather than throwing', async () => {
    stubFetch({ id: 'c1', name: 'Bare card', desc: '', due: null, dateLastActivity: '2026-08-01T00:00:00Z', idList: 'l1', idBoard: 'b1' });
    const result = await getTrelloCard.handler({ card_id: 'c1' });
    expect(result.isError).toBeUndefined();
    const t = text(result);
    expect(t).toContain('Bare card (c1)');
    expect(t).not.toContain('Labels:');
    expect(t).not.toContain('Members:');
    expect(t).not.toContain('Comments:');
    expect(t).not.toContain('Attachments:');
  });

  it('regression: labels present, everything else omitted', async () => {
    stubFetch({ id: 'c1', name: 'Labeled card', desc: '', due: null, dateLastActivity: '', idList: 'l1', idBoard: 'b1', labels: [{ name: 'Important' }] });
    const result = await getTrelloCard.handler({ card_id: 'c1' });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('Labels: Important');
  });

  it('regression: members present, everything else omitted', async () => {
    stubFetch({ id: 'c1', name: 'Assigned card', desc: '', due: null, dateLastActivity: '', idList: 'l1', idBoard: 'b1', members: [{ fullName: 'Ivan' }] });
    const result = await getTrelloCard.handler({ card_id: 'c1' });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('Members: Ivan');
  });

  it('regression: checklists present, everything else omitted', async () => {
    stubFetch({
      id: 'c1',
      name: 'Checklist card',
      desc: '',
      due: null,
      dateLastActivity: '',
      idList: 'l1',
      idBoard: 'b1',
      checklists: [{ name: 'Prep', checkItems: [{ name: 'Buy materials', state: 'incomplete' }] }],
    });
    const result = await getTrelloCard.handler({ card_id: 'c1' });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('Buy materials');
  });

  it('regression: comments/actions present, everything else omitted', async () => {
    stubFetch({
      id: 'c1',
      name: 'Commented card',
      desc: '',
      due: null,
      dateLastActivity: '',
      idList: 'l1',
      idBoard: 'b1',
      actions: [{ data: { text: 'On my way' }, memberCreator: { fullName: 'Ivan' }, date: '2026-08-01T00:00:00Z' }],
    });
    const result = await getTrelloCard.handler({ card_id: 'c1' });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('On my way');
  });

  it('regression: attachments present, everything else omitted', async () => {
    stubFetch({
      id: 'c1',
      name: 'Photo card',
      desc: '',
      due: null,
      dateLastActivity: '',
      idList: 'l1',
      idBoard: 'b1',
      attachments: [{ name: 'leak.jpg', url: 'https://example.com/leak.jpg' }],
    });
    const result = await getTrelloCard.handler({ card_id: 'c1' });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('leak.jpg');
  });
});

describe('error handling', () => {
  it('surfaces a trelloGet failure as a tool error, not a thrown exception', async () => {
    stubFetch({}, false, 401);
    const result = await searchTrelloCards.handler({ query: 'x' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('401');
  });
});
