import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';

let root;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'clidash-docsrv-'));
  const w = (rel, body) => {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  };
  w('groups/alpha/skills/tagger/SKILL.md', '# tagger\nhello');
  w('container/skills/welcome/SKILL.md', '# welcome');
  w('groups/alpha/profile.json', '{"name":"Alpha"}');
  w('groups/alpha/.env', 'SECRET=nope');
});

after(() => rmSync(root, { recursive: true, force: true }));

function docsConfig() {
  return {
    port: 0,
    bind: '127.0.0.1',
    clis: {},
    docs: {
      root,
      deny: ['node_modules', '.env', '*token*', '*secret*', '*.pem', '*.key'],
      collections: [
        { name: 'skills', label: 'Skills', lang: 'markdown', patterns: ['groups/*/skills/*/SKILL.md', 'container/skills/*/SKILL.md'] },
        { name: 'profiles', label: 'Profiles', lang: 'json', patterns: ['groups/*/profile.json'] },
      ],
    },
  };
}

async function withServer(config, fn) {
  const server = createApp(config);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('/api/docs: lists collections with their files', async () => {
  await withServer(docsConfig(), async (base) => {
    const body = await (await fetch(`${base}/api/docs`)).json();
    const skills = body.collections.find((c) => c.name === 'skills');
    assert.equal(skills.label, 'Skills');
    assert.equal(skills.lang, 'markdown');
    const paths = skills.files.map((f) => f.path);
    assert.ok(paths.includes('groups/alpha/skills/tagger/SKILL.md'));
    assert.ok(paths.includes('container/skills/welcome/SKILL.md'));
    // each file carries a readable label + group
    const f = skills.files.find((x) => x.path.includes('tagger'));
    assert.equal(f.group, 'alpha');
    assert.match(f.label, /tagger/);
  });
});

test('/api/doc: returns file content + lang', async () => {
  await withServer(docsConfig(), async (base) => {
    const url = `${base}/api/doc?c=skills&p=${encodeURIComponent('groups/alpha/skills/tagger/SKILL.md')}`;
    const body = await (await fetch(url)).json();
    assert.equal(body.ok, true);
    assert.equal(body.lang, 'markdown');
    assert.match(body.content, /# tagger/);
  });
});

test('/api/doc: a denied file is not readable even though it sits under root', async () => {
  await withServer(docsConfig(), async (base) => {
    // .env is excluded by the deny-list and not in any collection pattern
    const coll = docsConfig();
    coll.docs.collections.push({ name: 'all', label: 'All', lang: 'text', patterns: ['groups/*/*'] });
    await withServer(coll, async (base2) => {
      const res = await fetch(`${base2}/api/doc?c=all&p=${encodeURIComponent('groups/alpha/.env')}`);
      assert.equal(res.status, 404);
      assert.equal((await res.json()).ok, false);
    });
  });
});

test('/api/doc: path traversal is rejected', async () => {
  await withServer(docsConfig(), async (base) => {
    const res = await fetch(`${base}/api/doc?c=skills&p=${encodeURIComponent('../../../../etc/passwd')}`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).ok, false);
  });
});

test('/api/doc: unknown collection → 404', async () => {
  await withServer(docsConfig(), async (base) => {
    const res = await fetch(`${base}/api/doc?c=nope&p=x`);
    assert.equal(res.status, 404);
  });
});

test('/api/docs: absent docs config → empty collections, no crash', async () => {
  await withServer({ port: 0, bind: '127.0.0.1', clis: {} }, async (base) => {
    const body = await (await fetch(`${base}/api/docs`)).json();
    assert.deepEqual(body.collections, []);
  });
});
