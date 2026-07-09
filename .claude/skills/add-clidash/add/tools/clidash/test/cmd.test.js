import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';

const STUB = fileURLToPath(new URL('./fixtures/stub-cli.js', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'clidash-cmd-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function cli(extra = {}) {
  return {
    bin: process.execPath,
    discover: { args: [STUB, 'help'], parser: 'ncl-help' },
    list: [STUB, '{resource}', 'list', '--json'],
    output: 'json',
    unwrap: 'data',
    commands: {
      get: [STUB, '{resource}', 'get', '{id}', '--json'],
      'config-get': [STUB, 'groups', 'config', 'get', '--id', '{id}', '--json'],
    },
    ...extra,
  };
}

async function withServer(clis, fn, extra = {}) {
  const server = createApp({ port: 0, bind: '127.0.0.1', execTimeoutMs: 2000, clis, ...extra });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

test('/api/cmd: runs an allowlisted command with {resource} + {id}', async () => {
  await withServer({ ncl: cli() }, async (base) => {
    const body = await (await fetch(`${base}/api/cmd/ncl/get?resource=sessions&id=sess-123`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.data.id, 'sessions-detail');
    assert.match(body.data.args, /sessions get sess-123/);
  });
});

test('/api/cmd: config-get needs no resource', async () => {
  await withServer({ ncl: cli() }, async (base) => {
    const body = await (await fetch(`${base}/api/cmd/ncl/config-get?id=ag-1`)).json();
    assert.equal(body.ok, true);
    assert.match(body.data.args, /groups config get --id ag-1/);
  });
});

test('/api/cmd: unknown command name → 404 (allowlist)', async () => {
  await withServer({ ncl: cli() }, async (base) => {
    const res = await fetch(`${base}/api/cmd/ncl/delete?resource=groups&id=ag-1`);
    assert.equal(res.status, 404);
  });
});

test('/api/cmd: a {resource} not in the discovered set is rejected without exec', async () => {
  const countFile = join(tmp, 'cmd-count.txt');
  const c = cli();
  c.env = { STUB_COUNT_FILE: countFile };
  await withServer({ ncl: c }, async (base) => {
    const res = await fetch(`${base}/api/cmd/ncl/get?resource=evil&id=x`);
    assert.equal(res.status, 404);
    // only discovery ran, never a get for the bogus resource
    const calls = readFileSync(countFile, 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['help']);
  });
});

test('/api/cmd: an id with illegal characters is rejected', async () => {
  await withServer({ ncl: cli() }, async (base) => {
    const res = await fetch(`${base}/api/cmd/ncl/get?resource=sessions&id=${encodeURIComponent('a b;rm -rf')}`);
    assert.equal(res.status, 400);
  });
});

test('/api/cmd: unknown cli → 404', async () => {
  await withServer({ ncl: cli() }, async (base) => {
    assert.equal((await fetch(`${base}/api/cmd/nope/get?resource=sessions&id=x`)).status, 404);
  });
});

test('/api/cmd: a cli without a commands map → 404', async () => {
  const c = cli();
  delete c.commands;
  await withServer({ ncl: c }, async (base) => {
    assert.equal((await fetch(`${base}/api/cmd/ncl/get?resource=sessions&id=x`)).status, 404);
  });
});
