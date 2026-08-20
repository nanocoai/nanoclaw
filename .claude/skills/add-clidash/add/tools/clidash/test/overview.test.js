// Guards the Agents overview join — the one derived page in clidash, and the
// only place the dashboard shows numbers no single `ncl` command produces.
// public/overview.js is what the browser renders, so these assertions cover the
// rendered path rather than a parallel copy of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOverview, staleness } from '../public/overview.js';

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

// Shapes mirror real `ncl <resource> list --json` output.
function makeFixtures({ alphaLastActive, bravoLastActive }) {
  return {
    groups: [
      { id: 'ag-1', name: 'Alpha', folder: 'alpha', created_at: '2026-05-31T11:14:48.793Z' },
      { id: 'ag-2', name: 'Bravo Team', folder: 'bravo', created_at: '2026-05-31T11:14:48.796Z' },
      { id: 'ag-3', name: 'Orphan', folder: 'orphan', created_at: '2026-05-31T11:14:48.799Z' },
    ],
    sessions: [
      { id: 'sess-1', agent_group_id: 'ag-1', messaging_group_id: 'mg-1', thread_id: null, status: 'active', container_status: 'stopped', last_active: alphaLastActive, created_at: '2026-05-31T11:14:51.911Z' },
      { id: 'sess-2', agent_group_id: 'ag-2', messaging_group_id: 'mg-2', thread_id: null, status: 'active', container_status: 'running', last_active: bravoLastActive, created_at: '2026-05-31T11:14:51.973Z' },
    ],
    messagingGroups: [
      { id: 'mg-1', channel_type: 'telegram', platform_id: 'telegram:1', name: 'Alpha', is_group: 0 },
      { id: 'mg-2', channel_type: 'telegram', platform_id: 'telegram:2', name: 'Bravo Team', is_group: 0 },
    ],
    wirings: [
      { id: 'mga-1', messaging_group_id: 'mg-1', agent_group_id: 'ag-1', session_mode: 'shared' },
      { id: 'mga-2', messaging_group_id: 'mg-2', agent_group_id: 'ag-2', session_mode: 'shared' },
    ],
  };
}

const cardsOf = (result) => new Map(result.cards.map((c) => [c.title, c]));

test('overview: one card per agent group with joined session + wiring data', () => {
  const result = buildOverview(makeFixtures({ alphaLastActive: minutesAgo(5), bravoLastActive: minutesAgo(30) }));
  assert.equal(result.title, 'Agents overview');
  assert.equal(result.cards.length, 3);

  const cards = cardsOf(result);
  const alpha = cards.get('Alpha');
  assert.equal(alpha.subtitle, 'alpha');
  assert.equal(alpha.container, 'stopped');
  assert.equal(alpha.sessions, 1);
  assert.deepEqual(alpha.badges, ['telegram: Alpha']);

  const bravo = cards.get('Bravo Team');
  assert.equal(bravo.container, 'running');
  assert.deepEqual(bravo.badges, ['telegram: Bravo Team']);

  // A group with no sessions and no wirings still gets a card.
  const orphan = cards.get('Orphan');
  assert.equal(orphan.container, 'none');
  assert.equal(orphan.sessions, 0);
  assert.deepEqual(orphan.badges, []);
});

test('overview: staleness thresholds — green <15m, amber <2h, red older, gray never', () => {
  const result = buildOverview(makeFixtures({ alphaLastActive: minutesAgo(5), bravoLastActive: minutesAgo(30) }));
  const cards = cardsOf(result);
  assert.equal(cards.get('Alpha').status, 'green');
  assert.equal(cards.get('Bravo Team').status, 'amber');
  assert.equal(cards.get('Orphan').status, 'gray');

  const stale = buildOverview(makeFixtures({ alphaLastActive: minutesAgo(300), bravoLastActive: minutesAgo(30) }));
  assert.equal(cardsOf(stale).get('Alpha').status, 'red');
});

test('staleness: an unparseable timestamp is gray, not a thrown render', () => {
  assert.equal(staleness('not a date'), 'gray');
  assert.equal(staleness(null), 'gray');
});

test('overview: last_active is exposed raw for relative-time rendering', () => {
  const ts = minutesAgo(5);
  const result = buildOverview(makeFixtures({ alphaLastActive: ts, bravoLastActive: minutesAgo(30) }));
  assert.equal(cardsOf(result).get('Alpha').lastActive, ts);
});

test('overview: a group with several sessions reports running and the newest last_active', () => {
  const result = buildOverview({
    groups: [{ id: 'ag-1', name: 'Alpha', folder: 'alpha' }],
    sessions: [
      { id: 's1', agent_group_id: 'ag-1', container_status: 'stopped', last_active: '2026-08-19T10:00:00.000Z' },
      { id: 's2', agent_group_id: 'ag-1', container_status: 'running', last_active: '2026-08-20T10:00:00.000Z' },
      { id: 's3', agent_group_id: 'ag-other', container_status: 'running', last_active: '2026-08-21T10:00:00.000Z' },
    ],
  });
  const [card] = result.cards;
  assert.equal(card.sessions, 2);
  assert.equal(card.container, 'running');
  assert.equal(card.lastActive, '2026-08-20T10:00:00.000Z');
});

test('overview: message totals sum the activity rows of that group only', () => {
  const result = buildOverview({
    groups: [{ id: 'ag-1', name: 'Alpha', folder: 'alpha' }, { id: 'ag-2', name: 'Bravo', folder: 'bravo' }],
    activity: [
      { agent_group_id: 'ag-1', session_id: 's1', in: 3, out: 2 },
      { agent_group_id: 'ag-1', session_id: 's2', in: 1, out: 0 },
      { agent_group_id: 'ag-2', session_id: 's3', in: 9, out: 9 },
    ],
  });
  const cards = cardsOf(result);
  assert.equal(cards.get('Alpha').messagesIn, 4);
  assert.equal(cards.get('Alpha').messagesOut, 2);
  assert.equal(cards.get('Bravo').messagesIn, 9);
});

test('overview: no activity data yet → zero totals, not NaN', () => {
  const result = buildOverview({ groups: [{ id: 'ag-1', name: 'Alpha', folder: 'alpha' }] });
  assert.equal(result.cards[0].messagesIn, 0);
  assert.equal(result.cards[0].messagesOut, 0);
});

test('overview: container config is folded in with defaults for absent fields', () => {
  const configs = new Map([
    ['ag-1', { provider: 'opencode', model: 'sonnet', cli_scope: 'global', packages_apt: ['jq'], packages_npm: ['a', 'b'], mcp_servers: { tavily: {} } }],
    ['ag-2', {}],
  ]);
  const result = buildOverview({
    groups: [{ id: 'ag-1', name: 'Alpha', folder: 'alpha' }, { id: 'ag-2', name: 'Bravo', folder: 'bravo' }, { id: 'ag-3', name: 'Orphan', folder: 'orphan' }],
    configs,
  });
  const cards = cardsOf(result);
  assert.deepEqual(cards.get('Alpha').config, {
    provider: 'opencode', model: 'sonnet', cliScope: 'global', packages: 3, mcpServers: 1,
  });
  // An empty config still renders — the defaults are what `ncl groups config
  // get` omits, not "unknown".
  assert.deepEqual(cards.get('Bravo').config, {
    provider: 'claude', model: 'default', cliScope: 'group', packages: 0, mcpServers: 0,
  });
  // Not fetched yet → no config block at all.
  assert.equal(cards.get('Orphan').config, null);
});

test('overview: configs may be a plain object as well as a Map', () => {
  const result = buildOverview({
    groups: [{ id: 'ag-1', name: 'Alpha', folder: 'alpha' }],
    configs: { 'ag-1': { provider: 'codex' } },
  });
  assert.equal(result.cards[0].config.provider, 'codex');
});

test('overview: a wiring to an unnamed or unknown messaging group still labels', () => {
  const result = buildOverview({
    groups: [{ id: 'ag-1', name: 'Alpha', folder: 'alpha' }],
    messagingGroups: [{ id: 'mg-1', channel_type: 'discord', platform_id: 'discord:99', name: null }],
    wirings: [
      { id: 'w1', agent_group_id: 'ag-1', messaging_group_id: 'mg-1' },
      { id: 'w2', agent_group_id: 'ag-1', messaging_group_id: 'mg-gone' },
    ],
  });
  // name is null → fall back to platform_id; the row is missing → raw id.
  assert.deepEqual(result.cards[0].badges, ['discord: discord:99', 'mg-gone']);
});
