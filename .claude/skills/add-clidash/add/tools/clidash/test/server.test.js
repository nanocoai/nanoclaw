import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';

const STUB = fileURLToPath(new URL('./fixtures/stub-cli.js', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'clidash-test-'));

function stubCli(extra = {}) {
  return {
    bin: process.execPath,
    discover: { args: [STUB, 'help'], parser: 'ncl-help' },
    list: [STUB, '{resource}', 'list', '--json'],
    output: 'json',
    unwrap: 'data',
    ...extra,
  };
}

function makeConfig(clis, extra = {}) {
  return { port: 0, bind: '127.0.0.1', execTimeoutMs: 2000, refreshSeconds: 10, clis, ...extra };
}

async function withServer(config, fn) {
  const server = createApp(config);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

after(() => rmSync(tmp, { recursive: true, force: true }));

// ----------------------------------------------------------------- /api/clis

test('/api/clis: lists configured CLIs with discovered resources', async () => {
  await withServer(makeConfig({ stub: stubCli() }), async (base) => {
    const res = await fetch(`${base}/api/clis`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.clis.length, 1);
    assert.equal(body.clis[0].name, 'stub');
    assert.equal(body.clis[0].refreshSeconds, 10);
    const names = body.clis[0].resources.map((r) => r.name);
    assert.ok(names.includes('sessions'));
    assert.ok(names.includes('groups'));
    assert.equal(names.length, 11);
  });
});

test('/api/clis: static resource list needs no discovery', async () => {
  const cli = stubCli({ resources: ['alpha', 'beta'] });
  delete cli.discover;
  await withServer(makeConfig({ stub: cli }), async (base) => {
    const body = await (await fetch(`${base}/api/clis`)).json();
    assert.deepEqual(body.clis[0].resources.map((r) => r.name), ['alpha', 'beta']);
  });
});

test('/api/clis: discovery failure reports a loud error', async () => {
  const cli = stubCli();
  cli.env = { STUB_FAIL: '1' };
  await withServer(makeConfig({ stub: cli }), async (base) => {
    const body = await (await fetch(`${base}/api/clis`)).json();
    assert.equal(body.clis[0].resources.length, 0);
    assert.match(body.clis[0].error, /boom/);
  });
});

// ------------------------------------------------------------ /api/r/cli/res

test('/api/r: returns unwrapped rows with fetchedAt', async () => {
  await withServer(makeConfig({ stub: stubCli() }), async (base) => {
    const res = await fetch(`${base}/api/r/stub/sessions`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.rows.map((r) => r.id), ['sessions-1', 'sessions-2']);
    assert.ok(body.fetchedAt);
  });
});

test('/api/r: rejects a resource not in the discovered set without exec', async () => {
  const countFile = join(tmp, 'count-reject.txt');
  const cli = stubCli();
  cli.env = { STUB_COUNT_FILE: countFile };
  await withServer(makeConfig({ stub: cli }), async (base) => {
    const res = await fetch(`${base}/api/r/stub/evil%20--rm`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.ok, false);
    // only the discovery exec ran — never a list exec for the bogus resource
    const calls = readFileSync(countFile, 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['help']);
  });
});

test('/api/r: unknown cli → 404', async () => {
  await withServer(makeConfig({ stub: stubCli() }), async (base) => {
    const res = await fetch(`${base}/api/r/nope/sessions`);
    assert.equal(res.status, 404);
  });
});

test('/api/r: jsonlines CLI with static resources works', async () => {
  const cli = {
    bin: process.execPath,
    resources: ['ps'],
    list: [STUB, '{resource}'],
    output: 'jsonlines',
    env: { STUB_JSONLINES: '1' },
  };
  await withServer(makeConfig({ docker: cli }), async (base) => {
    const body = await (await fetch(`${base}/api/r/docker/ps`)).json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.rows.map((r) => r.id), ['ps-1', 'ps-2']);
  });
});

test('/api/r: exec failure returns ok:false with stderr', async () => {
  const cli = stubCli({ resources: ['sessions'] });
  delete cli.discover;
  cli.env = { STUB_FAIL: '1' };
  await withServer(makeConfig({ stub: cli }), async (base) => {
    const res = await fetch(`${base}/api/r/stub/sessions`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /boom: socket down/);
  });
});

test('/api/r: exec timeout returns ok:false naming the resource', async () => {
  const cli = stubCli({ resources: ['sessions'] });
  delete cli.discover;
  cli.env = { STUB_SLEEP_MS: '5000' };
  await withServer(makeConfig({ stub: cli }, { execTimeoutMs: 200 }), async (base) => {
    const body = await (await fetch(`${base}/api/r/stub/sessions`)).json();
    assert.equal(body.ok, false);
    assert.match(body.error, /sessions/);
    assert.match(body.error, /timed out/i);
  });
});

test('/api/r: malformed CLI output returns the raw output', async () => {
  const cli = stubCli({ resources: ['sessions'] });
  delete cli.discover;
  cli.env = { STUB_RAW: 'this is not json' };
  await withServer(makeConfig({ stub: cli }), async (base) => {
    const body = await (await fetch(`${base}/api/r/stub/sessions`)).json();
    assert.equal(body.ok, false);
    assert.match(body.raw, /this is not json/);
  });
});

test('/api/r: concurrent requests for the same resource coalesce into one exec', async () => {
  const countFile = join(tmp, 'count-coalesce.txt');
  const cli = stubCli({ resources: ['sessions'] });
  delete cli.discover;
  cli.env = { STUB_COUNT_FILE: countFile, STUB_SLEEP_MS: '150' };
  await withServer(makeConfig({ stub: cli }), async (base) => {
    const bodies = await Promise.all(
      Array.from({ length: 5 }, () => fetch(`${base}/api/r/stub/sessions`).then((r) => r.json())),
    );
    for (const body of bodies) assert.equal(body.ok, true);
    const calls = readFileSync(countFile, 'utf8').trim().split('\n');
    assert.equal(calls.length, 1);
  });
});

// ------------------------------------------------------------- /api/view

test('/api/view: runs a view plugin with a bound fetch helper', async () => {
  const viewsDir = join(tmp, 'views');
  writeFileSync(join(viewsDir, '..', 'placeholder'), ''); // ensure tmp exists
  const { mkdirSync } = await import('node:fs');
  mkdirSync(viewsDir, { recursive: true });
  writeFileSync(
    join(viewsDir, 'stub-overview.js'),
    'export default async function ({ fetch }) {\n' +
    '  const rows = await fetch("sessions");\n' +
    '  return { count: rows.length, first: rows[0].id };\n' +
    '}\n',
  );
  await withServer(makeConfig({ stub: stubCli() }, { viewsDir }), async (base) => {
    const res = await fetch(`${base}/api/view/stub/overview`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.result, { count: 2, first: 'sessions-1' });
  });
});

test('/api/view: missing view → 404; bad view name → 404', async () => {
  await withServer(makeConfig({ stub: stubCli() }, { viewsDir: join(tmp, 'views') }), async (base) => {
    assert.equal((await fetch(`${base}/api/view/stub/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/view/stub/..%2F..%2Fserver`)).status, 404);
  });
});

// ------------------------------------------------------------- static files

test('GET /: serves the dashboard index.html', async () => {
  await withServer(makeConfig({ stub: stubCli() }), async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /clidash/i);
  });
});

test('static: path traversal outside public/ is rejected', async () => {
  await withServer(makeConfig({ stub: stubCli() }), async (base) => {
    const res = await fetch(`${base}/..%2Fserver.js`);
    assert.notEqual(res.status, 200);
  });
});

test('/api/r: {resource} substitutes inside a larger argv string (ssh-remote pattern)', async () => {
  const cli = {
    bin: process.execPath,
    resources: ['sessions'],
    list: [STUB, 'wrapped-{resource}-arg', 'list'],
    output: 'json',
    unwrap: 'data',
    env: { STUB_COUNT_FILE: join(tmp, 'count-embed.txt') },
  };
  await withServer(makeConfig({ stub: cli }), async (base) => {
    const body = await (await fetch(`${base}/api/r/stub/sessions`)).json();
    assert.equal(body.ok, true);
    const calls = readFileSync(join(tmp, 'count-embed.txt'), 'utf8').trim();
    assert.equal(calls, 'wrapped-sessions-arg list');
  });
});
