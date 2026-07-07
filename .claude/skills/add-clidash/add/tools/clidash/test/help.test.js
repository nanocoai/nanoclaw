import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';

const STUB = fileURLToPath(new URL('./fixtures/stub-cli.js', import.meta.url));

function cli(extra = {}) {
  return {
    bin: process.execPath,
    discover: { args: [STUB, 'help'], parser: 'ncl-help' },
    list: [STUB, '{resource}', 'list', '--json'],
    output: 'json', unwrap: 'data',
    help: [STUB, '{resource}', 'help'],
    ...extra,
  };
}

async function withServer(clis, fn) {
  const server = createApp({ port: 0, bind: '127.0.0.1', execTimeoutMs: 2000, clis });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

test('/api/help: returns raw per-resource help text', async () => {
  await withServer({ ncl: cli() }, async (base) => {
    const body = await (await fetch(`${base}/api/help/ncl/sessions`)).json();
    assert.equal(body.ok, true);
    assert.match(body.text, /sessions: help for sessions/);
    assert.match(body.text, /Verbs:/);
  });
});

test('/api/help: undiscovered resource → 404', async () => {
  await withServer({ ncl: cli() }, async (base) => {
    assert.equal((await fetch(`${base}/api/help/ncl/evil`)).status, 404);
  });
});

test('/api/help: a cli without a help template → 404', async () => {
  const c = cli(); delete c.help;
  await withServer({ ncl: c }, async (base) => {
    assert.equal((await fetch(`${base}/api/help/ncl/sessions`)).status, 404);
  });
});

test('/api/help: unknown cli → 404', async () => {
  await withServer({ ncl: cli() }, async (base) => {
    assert.equal((await fetch(`${base}/api/help/nope/sessions`)).status, 404);
  });
});

test('/api/clis: reports help availability per cli', async () => {
  const noHelp = cli(); delete noHelp.help;
  await withServer({ ncl: cli(), docker: noHelp }, async (base) => {
    const body = await (await fetch(`${base}/api/clis`)).json();
    assert.equal(body.clis.find((c) => c.name === 'ncl').help, true);
    assert.equal(body.clis.find((c) => c.name === 'docker').help, false);
  });
});
