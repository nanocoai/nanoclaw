import { test } from 'node:test';
import assert from 'node:assert/strict';
import overview from '../views/ncl-overview.js';

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
    'messaging-groups': [
      { id: 'mg-1', channel_type: 'telegram', platform_id: 'telegram:1', name: 'Alpha', is_group: 0 },
      { id: 'mg-2', channel_type: 'telegram', platform_id: 'telegram:2', name: 'Bravo Team', is_group: 0 },
    ],
    wirings: [
      { id: 'mga-1', messaging_group_id: 'mg-1', agent_group_id: 'ag-1', session_mode: 'shared' },
      { id: 'mga-2', messaging_group_id: 'mg-2', agent_group_id: 'ag-2', session_mode: 'shared' },
    ],
  };
}

function fetchFrom(fixtures) {
  return async (resource) => {
    if (!(resource in fixtures)) throw new Error(`unexpected fetch: ${resource}`);
    return fixtures[resource];
  };
}

test('overview: one card per agent group with joined session + wiring data', async () => {
  const fixtures = makeFixtures({ alphaLastActive: minutesAgo(5), bravoLastActive: minutesAgo(30) });
  const result = await overview({ fetch: fetchFrom(fixtures) });
  assert.equal(result.cards.length, 3);

  const alpha = result.cards.find((c) => c.title === 'Alpha');
  assert.equal(alpha.subtitle, 'alpha');
  assert.equal(alpha.fields.container, 'stopped');
  assert.equal(alpha.fields.sessions, 1);
  assert.deepEqual(alpha.badges, ['telegram: Alpha']);

  const bravo = result.cards.find((c) => c.title === 'Bravo Team');
  assert.equal(bravo.fields.container, 'running');
  assert.deepEqual(bravo.badges, ['telegram: Bravo Team']);
});

test('overview: staleness thresholds — green <15m, amber <2h, red older, gray never', async () => {
  const fixtures = makeFixtures({ alphaLastActive: minutesAgo(5), bravoLastActive: minutesAgo(30) });
  const result = await overview({ fetch: fetchFrom(fixtures) });
  assert.equal(result.cards.find((c) => c.title === 'Alpha').status, 'green');
  assert.equal(result.cards.find((c) => c.title === 'Bravo Team').status, 'amber');
  assert.equal(result.cards.find((c) => c.title === 'Orphan').status, 'gray');

  const stale = makeFixtures({ alphaLastActive: minutesAgo(300), bravoLastActive: minutesAgo(30) });
  const result2 = await overview({ fetch: fetchFrom(stale) });
  assert.equal(result2.cards.find((c) => c.title === 'Alpha').status, 'red');
});

test('overview: last_active is exposed for relative-time rendering', async () => {
  const ts = minutesAgo(5);
  const fixtures = makeFixtures({ alphaLastActive: ts, bravoLastActive: minutesAgo(30) });
  const result = await overview({ fetch: fetchFrom(fixtures) });
  assert.equal(result.cards.find((c) => c.title === 'Alpha').fields['last active'], ts);
});
