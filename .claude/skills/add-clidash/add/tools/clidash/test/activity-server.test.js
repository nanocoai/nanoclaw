import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.js';

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'clidash-actsrv-'));
  mkdirSync(join(root, 'ag-1', 'sess-1'), { recursive: true });
  const mk = (p, t, ts) => { const db = new DatabaseSync(p); db.exec(`CREATE TABLE ${t}(id TEXT, timestamp TEXT)`); const i = db.prepare(`INSERT INTO ${t} VALUES (?,?)`); ts.forEach((x, n) => i.run(String(n), x)); db.close(); };
  const today = new Date().toISOString().slice(0, 10);
  mk(join(root, 'ag-1', 'sess-1', 'inbound.db'), 'messages_in', [`${today} 09:00:00`, `${today} 10:00:00`]);
  mk(join(root, 'ag-1', 'sess-1', 'outbound.db'), 'messages_out', [`${today} 09:05:00`]);
});
after(() => rmSync(root, { recursive: true, force: true }));

async function withServer(config, fn) {
  const server = createApp({ port: 0, bind: '127.0.0.1', clis: {}, ...config });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

test('/api/activity: returns per-session totals + a daily series', async () => {
  await withServer({ activity: { sessionsRoot: root, days: 14 } }, async (base) => {
    const body = await (await fetch(`${base}/api/activity`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.configured, true);
    assert.equal(body.series.length, 14);
    assert.equal(body.sessions[0].in, 2);
    assert.equal(body.sessions[0].out, 1);
    assert.equal(body.series.at(-1).in, 2); // today
    assert.equal(body.series.at(-1).out, 1);
  });
});

test('/api/activity: not configured → configured:false, no crash', async () => {
  await withServer({}, async (base) => {
    const body = await (await fetch(`${base}/api/activity`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.configured, false);
  });
});
