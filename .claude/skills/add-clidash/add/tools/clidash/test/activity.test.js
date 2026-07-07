import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collectActivity } from '../activity.js';

let root;
const NOW = new Date('2026-06-14T12:00:00Z');

function makeDb(path, table, timestamps) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE ${table} (id TEXT, timestamp TEXT)`);
  const ins = db.prepare(`INSERT INTO ${table} (id, timestamp) VALUES (?, ?)`);
  timestamps.forEach((t, i) => ins.run(String(i), t));
  db.close();
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'clidash-act-'));
  // session 1 (group ag-1): 3 inbound across 2 days, 2 outbound today
  mkdirSync(join(root, 'ag-1', 'sess-1'), { recursive: true });
  makeDb(join(root, 'ag-1', 'sess-1', 'inbound.db'), 'messages_in',
    ['2026-06-14 09:01:23', '2026-06-14 10:00:00', '2026-06-13 08:00:00']);
  makeDb(join(root, 'ag-1', 'sess-1', 'outbound.db'), 'messages_out',
    ['2026-06-14 09:05:00', '2026-06-14 10:05:00']);
  // session 2 (group ag-2): 1 inbound 20 days ago (outside 14d window), 0 outbound
  mkdirSync(join(root, 'ag-2', 'sess-2'), { recursive: true });
  makeDb(join(root, 'ag-2', 'sess-2', 'inbound.db'), 'messages_in', ['2026-05-25 08:00:00']);
  makeDb(join(root, 'ag-2', 'sess-2', 'outbound.db'), 'messages_out', []);
});

after(() => rmSync(root, { recursive: true, force: true }));

test('collectActivity: per-session in/out totals + last activity', () => {
  const { sessions } = collectActivity(root, 14, NOW);
  const s1 = sessions.find((s) => s.session_id === 'sess-1');
  assert.equal(s1.agent_group_id, 'ag-1');
  assert.equal(s1.in, 3);
  assert.equal(s1.out, 2);
  assert.equal(s1.lastActivity, '2026-06-14T10:05:00Z'); // normalized to ISO
  const s2 = sessions.find((s) => s.session_id === 'sess-2');
  assert.equal(s2.in, 1);
  assert.equal(s2.out, 0);
});

test('collectActivity: series has one bucket per day for `days`, newest last', () => {
  const { series } = collectActivity(root, 14, NOW);
  assert.equal(series.length, 14);
  assert.equal(series[0].date, '2026-06-01');
  assert.equal(series[13].date, '2026-06-14');
});

test('collectActivity: counts land in the right day buckets', () => {
  const { series } = collectActivity(root, 14, NOW);
  const byDate = Object.fromEntries(series.map((d) => [d.date, d]));
  assert.equal(byDate['2026-06-14'].in, 2);
  assert.equal(byDate['2026-06-14'].out, 2);
  assert.equal(byDate['2026-06-13'].in, 1);
  assert.equal(byDate['2026-06-13'].out, 0);
});

test('collectActivity: messages outside the window are counted in totals but not the series', () => {
  const { series, sessions } = collectActivity(root, 14, NOW);
  const total = series.reduce((a, d) => a + d.in + d.out, 0);
  assert.equal(total, 5);              // the 20-day-old message is excluded from series
  assert.equal(sessions.find((s) => s.session_id === 'sess-2').in, 1); // but still in the total count
});

test('collectActivity: a dir with no message DBs is not a session (skipped)', () => {
  mkdirSync(join(root, 'ag-1', '.claude-shared'), { recursive: true }); // scaffolding, no db files
  const { sessions } = collectActivity(root, 14, NOW);
  assert.ok(!sessions.some((s) => s.session_id === '.claude-shared'));
});
