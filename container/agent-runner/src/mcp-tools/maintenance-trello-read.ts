/**
 * Maintenance Coordinator's live, read-only Trello tools.
 *
 * Unlike every other tool in maintenance-coordinator.ts, these are NOT
 * fire-and-forget -- there's no host-owned DB row to write, so there's
 * nothing for the host to process. Each handler calls the Trello API
 * directly (via trelloGet, the single GET-only chokepoint) and returns
 * the real answer in the same turn.
 *
 * Because these tools never touch the host's message queue, the usual
 * "the host validates the caller's agent group" gate (used by every
 * fire-and-forget tool in this file's sibling module) doesn't apply here
 * -- there is no host round trip to validate. Self-gating here, reading
 * the same /workspace/agent/container.json every container already has,
 * is what keeps this Maintenance-Coordinator-only in practice, the same
 * way the sibling module's tools are host-gated to their own agent group.
 *
 * Worker-facing disclosure (never dumping raw board/card contents, never
 * surfacing unrelated/personal boards, staying within the existing
 * priority hierarchy) is enforced in instructions.prepend.md, not here --
 * these tools return real search/read results; what's actually said to a
 * worker is the agent's judgment call, same as every other disclosure
 * rule in this persona.
 *
 * Ported verbatim from old commit 824318ff -- no DB access, no async
 * adaptation needed.
 */
import fs from 'fs';

import { registerTools } from './server.js';
import { trelloGet } from './trello-read-client.js';
import type { McpToolDefinition } from './types.js';

// Must match MAINTENANCE_COORDINATOR_AGENT_GROUP_ID in
// src/modules/maintenance-worker-actions/config.ts (host-side). Duplicated
// here because this process (the MCP server) never loads the host's config
// module -- it's a separate tree with its own tsconfig, and this file
// reads the same /workspace/agent/container.json directly instead.
const MAINTENANCE_COORDINATOR_AGENT_GROUP_ID = 'ag-0bed629f-db95-4547-bd12-41eea5e6fbe5';

const CONTAINER_CONFIG_PATH = '/workspace/agent/container.json';

function callerIsMaintenanceCoordinator(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(CONTAINER_CONFIG_PATH, 'utf8')) as { agentGroupId?: string };
    return raw.agentGroupId === MAINTENANCE_COORDINATOR_AGENT_GROUP_ID;
  } catch {
    return false;
  }
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function notPermitted() {
  return err('not permitted for this agent.');
}

interface TrelloBoardSummary {
  id: string;
  name: string;
  url?: string;
  closed?: boolean;
}

export const listTrelloBoards: McpToolDefinition = {
  tool: {
    name: 'list_trello_boards',
    description:
      'List every Trello board the connected account can see (read-only). Includes boards beyond Properties -- other boards may hold relevant maintenance work too. When relaying results to a worker, mention only what is actually relevant to their work, never a full board dump.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        include_closed: { type: 'boolean' as const, description: 'Include closed/archived boards (default: false).' },
      },
    },
  },
  async handler(args) {
    if (!callerIsMaintenanceCoordinator()) return notPermitted();
    const includeClosed = args.include_closed === true;
    try {
      const boards = (await trelloGet('/1/members/me/boards', { fields: 'id,name,url,closed' })) as TrelloBoardSummary[];
      const filtered = includeClosed ? boards : boards.filter((b) => !b.closed);
      if (filtered.length === 0) return ok('No boards visible.');
      return ok(filtered.map((b) => `${b.name} (${b.id})${b.closed ? ' [closed]' : ''}`).join('\n'));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

interface TrelloListSummary {
  id: string;
  name: string;
}
interface TrelloCardSummary {
  id: string;
  name: string;
  idList: string;
  due: string | null;
  dateLastActivity: string;
}
interface TrelloBoardDetail {
  id: string;
  name: string;
  lists: TrelloListSummary[];
  cards: TrelloCardSummary[];
}

export const getTrelloBoard: McpToolDefinition = {
  tool: {
    name: 'get_trello_board',
    description:
      'Get one Trello board\'s open lists and cards (read-only, lightweight summary -- use get_trello_card for full detail on one card). Never relay this as a raw dump to a worker; extract only what is relevant to them.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        board_id: { type: 'string' as const, description: 'The Trello board id (from list_trello_boards).' },
      },
      required: ['board_id'],
    },
  },
  async handler(args) {
    if (!callerIsMaintenanceCoordinator()) return notPermitted();
    const boardId = args.board_id as string;
    if (!boardId) return err('board_id is required.');
    try {
      const board = (await trelloGet(`/1/boards/${boardId}`, {
        fields: 'id,name',
        lists: 'open',
        list_fields: 'name',
        cards: 'visible',
        card_fields: 'name,idList,due,dateLastActivity',
      })) as TrelloBoardDetail;
      const listsById = new Map(board.lists.map((l) => [l.id, l.name]));
      const lines = board.cards.map((c) => `${c.name} [${listsById.get(c.idList) ?? 'unknown list'}]${c.due ? ` (due ${c.due})` : ''} (${c.id})`);
      return ok(`${board.name}:\n${lines.length ? lines.join('\n') : '(no visible cards)'}`);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

interface TrelloSearchCard {
  id: string;
  name: string;
  desc: string;
  due: string | null;
  dateLastActivity: string;
  idBoard: string;
  idList: string;
  closed: boolean;
  labels?: { name: string }[];
  // Nested objects attached via the search-specific card_board/card_list/
  // card_members include flags below -- confirmed live: /1/search does NOT
  // use the same list=true/board=true shape as GET /1/cards/{id}; it needs
  // its own card_board/card_list/card_members params instead. Optional
  // because Trello can still omit them.
  board?: { name: string };
  list?: { name: string };
  members?: { fullName: string }[];
}
interface TrelloSearchResult {
  cards: TrelloSearchCard[];
}

export const searchTrelloCards: McpToolDefinition = {
  tool: {
    name: 'search_trello_cards',
    description:
      'Search across every accessible Trello board for cards matching free text (property/address/unit/keyword) -- read-only. Results include the board name, list name (e.g. "Apartments to Get Ready"), assigned members, and labels where Trello has them set -- use these to judge priority (see your priority hierarchy), not just raw addresses. Excludes archived/closed cards by default. Searches all boards, not just Properties -- relevant maintenance work can exist elsewhere. When telling a worker what you found, summarize the relevant task/property/priority in plain language; never relay raw search results or mention unrelated cards/boards.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' as const, description: 'Free-text search (e.g. a property address, alias, or keyword).' },
        board_id: { type: 'string' as const, description: 'Optional: restrict the search to one board id.' },
        include_completed: { type: 'boolean' as const, description: 'Include archived/closed cards (default: false).' },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    if (!callerIsMaintenanceCoordinator()) return notPermitted();
    const query = args.query as string;
    if (!query) return err('query is required.');
    const boardId = args.board_id as string | undefined;
    const includeCompleted = args.include_completed === true;
    try {
      const fullQuery = boardId ? `${query} board:${boardId}` : query;
      const result = (await trelloGet('/1/search', {
        query: fullQuery,
        modelTypes: 'cards',
        cards_limit: '50',
        card_fields: 'name,desc,due,dateLastActivity,idBoard,idList,closed,labels',
        // Embed human-meaningful board/list/member names on each result --
        // confirmed live: card_fields alone (even listing "list"/"board")
        // does not attach these; these are the correct, separate include
        // flags for /1/search specifically.
        card_board: 'true',
        card_list: 'true',
        card_members: 'true',
      })) as TrelloSearchResult;
      const cards = includeCompleted ? result.cards : result.cards.filter((c) => !c.closed);
      if (cards.length === 0) return ok('No matching cards found.');
      return ok(
        cards
          .map((c) => {
            const board = c.board?.name ?? `board ${c.idBoard}`;
            const list = c.list?.name ? `, list "${c.list.name}"` : '';
            const due = c.due ? ` due ${c.due}` : '';
            const labels = c.labels?.length ? ` [${c.labels.map((l) => l.name).join(', ')}]` : '';
            const members = c.members?.length ? ` (assigned: ${c.members.map((m) => m.fullName).join(', ')})` : '';
            return `${c.name} (${c.id}, ${board}${list})${due}${labels}${members}`;
          })
          .join('\n'),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

interface TrelloChecklistItem {
  name: string;
  state: string;
}
interface TrelloChecklist {
  name: string;
  checkItems: TrelloChecklistItem[];
}
interface TrelloAction {
  data: { text: string };
  memberCreator?: { fullName: string };
  date: string;
}
interface TrelloAttachment {
  name: string;
  url: string;
}
interface TrelloMember {
  fullName: string;
}
interface TrelloLabel {
  name: string;
}
interface TrelloCardDetail {
  id: string;
  name: string;
  desc: string;
  due: string | null;
  dateLastActivity: string;
  idList: string;
  idBoard: string;
  // Trello omits these keys entirely rather than returning an empty array
  // when there's nothing to report -- always optional, never assume present.
  checklists?: TrelloChecklist[];
  actions?: TrelloAction[];
  attachments?: TrelloAttachment[];
  members?: TrelloMember[];
  labels?: TrelloLabel[];
  // Nested board/list objects, attached via the separate list=true/board=true
  // include flags below (confirmed live: GET /1/cards/{id} needs these as
  // their own params, NOT added to `fields` -- unlike labels, which is the
  // other way around: must be in `fields`, a separate labels=true does
  // nothing). Two different inclusion mechanisms on the same endpoint.
  list?: { name: string };
  board?: { name: string };
}

export const getTrelloCard: McpToolDefinition = {
  tool: {
    name: 'get_trello_card',
    description:
      'Get full detail on one Trello card by id -- board name, list name (e.g. "Apartments to Get Ready"), description, checklist items, comments, attachments, due date, members, labels (all read-only). Use board/list/labels/members together with your priority hierarchy, not just the raw title. Use after search_trello_cards or get_trello_board to look at one specific card closely.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        card_id: { type: 'string' as const, description: 'The Trello card id.' },
      },
      required: ['card_id'],
    },
  },
  async handler(args) {
    if (!callerIsMaintenanceCoordinator()) return notPermitted();
    const cardId = args.card_id as string;
    if (!cardId) return err('card_id is required.');
    try {
      const card = (await trelloGet(`/1/cards/${cardId}`, {
        // "labels" must be in `fields` for Trello to attach the labels array at
        // all -- a separate labels=true/all include flag alone does not
        // (confirmed via a live GET-only smoke test against a real labeled
        // card: fields including "labels" -> labels array present; fields
        // without it, even with labels=all set, -> no labels key at all).
        fields: 'name,desc,due,dateLastActivity,idList,idBoard,labels',
        checklists: 'all',
        actions: 'commentCard',
        attachments: 'true',
        members: 'true',
        member_fields: 'fullName',
        // Confirmed live against a real card: these must be separate
        // boolean params, NOT listed in `fields` (list/board in `fields`
        // returns neither key at all).
        list: 'true',
        board: 'true',
      })) as TrelloCardDetail;

      // Trello omits any of these keys entirely when there's nothing to
      // report (e.g. a card with no comments has no `actions` key at all,
      // not an empty array) -- default each to [] so formatting below never
      // runs .length/.map/iteration directly on undefined.
      const labels = card.labels ?? [];
      const members = card.members ?? [];
      const checklists = card.checklists ?? [];
      const actions = card.actions ?? [];
      const attachments = card.attachments ?? [];

      const lines: string[] = [`${card.name} (${card.id})`];
      lines.push(`Board: ${card.board?.name ?? `(unknown, id ${card.idBoard})`}`);
      lines.push(`List: ${card.list?.name ?? `(unknown, id ${card.idList})`}`);
      if (card.desc) lines.push(`Description: ${card.desc}`);
      if (card.due) lines.push(`Due: ${card.due}`);
      if (labels.length) lines.push(`Labels: ${labels.map((l) => l.name).join(', ')}`);
      if (members.length) lines.push(`Members: ${members.map((m) => m.fullName).join(', ')}`);
      for (const cl of checklists) {
        lines.push(`Checklist "${cl.name}": ${cl.checkItems.map((i) => `${i.state === 'complete' ? '[x]' : '[ ]'} ${i.name}`).join('; ') || '(empty)'}`);
      }
      if (actions.length) {
        lines.push(`Comments: ${actions.map((a) => `${a.memberCreator?.fullName ?? '?'}: ${a.data.text}`).join(' | ')}`);
      }
      if (attachments.length) {
        lines.push(`Attachments: ${attachments.map((a) => a.name).join(', ')}`);
      }
      return ok(lines.join('\n'));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

registerTools([listTrelloBoards, getTrelloBoard, searchTrelloCards, getTrelloCard]);
