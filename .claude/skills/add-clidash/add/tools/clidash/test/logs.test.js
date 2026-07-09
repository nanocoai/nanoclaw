import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tailFile } from '../logs.js';
import { createApp } from '../server.js';

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'clidash-logs-'));
  // 10 lines, some with ANSI color codes
  const lines = Array.from({ length: 10 }, (_, i) =>
    `[12:00:0${i}] \x1b[32mINFO\x1b[39m line ${i}`);
  writeFileSync(join(dir, 'app.log'), lines.join('\n') + '\n');
  writeFileSync(join(dir, 'error.log'), 'boom\n');
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('tailFile: returns the last N lines, ANSI stripped, no trailing blank', async () => {
  const { lines, text } = await tailFile(join(dir, 'app.log'), 3);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines, ['[12:00:07] INFO line 7', '[12:00:08] INFO line 8', '[12:00:09] INFO line 9']);
  assert.ok(!text.includes('\x1b'));
});

test('tailFile: maxLines larger than file returns all lines', async () => {
  const { lines } = await tailFile(join(dir, 'app.log'), 100);
  assert.equal(lines.length, 10);
});

// ---- server endpoints ----

function cfg() {
  return {
    port: 0, bind: '127.0.0.1', clis: {},
    logs: { dir, tailLines: 5, files: [{ name: 'app.log', label: 'app' }, { name: 'error.log', label: 'errors' }] },
  };
}
async function withServer(config, fn) {
  const server = createApp(config);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

test('/api/logs: lists the configured log files', async () => {
  await withServer(cfg(), async (base) => {
    const body = await (await fetch(`${base}/api/logs`)).json();
    assert.deepEqual(body.files.map((f) => f.name), ['app.log', 'error.log']);
  });
});

test('/api/logs: absent logs config → empty list', async () => {
  await withServer({ port: 0, bind: '127.0.0.1', clis: {} }, async (base) => {
    assert.deepEqual((await (await fetch(`${base}/api/logs`)).json()).files, []);
  });
});

test('/api/log: returns the tail text + a tail command', async () => {
  await withServer(cfg(), async (base) => {
    const body = await (await fetch(`${base}/api/log/app.log`)).json();
    assert.equal(body.ok, true);
    assert.match(body.text, /line 9$/);
    assert.equal(body.text.split('\n').length, 5); // tailLines
    assert.match(body.command, /tail -n 5 .*app\.log/);
  });
});

test('/api/log: a name not in the allowlist is rejected (no traversal)', async () => {
  await withServer(cfg(), async (base) => {
    assert.equal((await fetch(`${base}/api/log/${encodeURIComponent('../../etc/passwd')}`)).status, 404);
    assert.equal((await fetch(`${base}/api/log/secrets.log`)).status, 404);
  });
});
