import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { discoveryParsers, parseOutput, unwrapPath } from '../parsers.js';

const fixture = readFileSync(
  fileURLToPath(new URL('./fixtures/ncl-help.txt', import.meta.url)),
  'utf8',
);

// ---------------------------------------------------------------- ncl-help

test('ncl-help: parses all listable resources from real captured output', () => {
  const resources = discoveryParsers['ncl-help'](fixture);
  assert.deepEqual(
    resources.map((r) => r.name),
    [
      'approvals', 'destinations', 'dropped-messages', 'groups', 'members',
      'messaging-groups', 'roles', 'sessions', 'user-dms', 'users', 'wirings',
    ],
  );
});

test('ncl-help: every parsed resource has a non-empty description and a list verb', () => {
  const resources = discoveryParsers['ncl-help'](fixture);
  for (const r of resources) {
    assert.ok(r.description.length > 0, `${r.name} has empty description`);
    assert.ok(r.verbs.includes('list'), `${r.name} missing list verb`);
  }
});

test('ncl-help: parses verbs correctly, including multi-word verbs', () => {
  const resources = discoveryParsers['ncl-help'](fixture);
  const groups = resources.find((r) => r.name === 'groups');
  assert.deepEqual(groups.verbs, [
    'list', 'get', 'create', 'update', 'delete', 'restart',
    'config get', 'config update', 'config add-mcp-server',
    'config remove-mcp-server', 'config add-package', 'config remove-package',
  ]);
});

test('ncl-help: excludes resources without a list verb', () => {
  const input = [
    'Resources:',
    '  alpha                Has list.',
    '                       verbs: list, get',
    '  beta                 No list here.',
    '                       verbs: grant, revoke',
    '',
  ].join('\n');
  const resources = discoveryParsers['ncl-help'](input);
  assert.deepEqual(resources.map((r) => r.name), ['alpha']);
});

test('ncl-help: ignores the Commands section (help is not a resource)', () => {
  const resources = discoveryParsers['ncl-help'](fixture);
  assert.ok(!resources.some((r) => r.name === 'help'));
});

test('ncl-help: throws loudly on unrecognized format', () => {
  assert.throws(() => discoveryParsers['ncl-help']('totally not help output'), /Resources/);
  assert.throws(() => discoveryParsers['ncl-help'](''), /Resources/);
});

// ------------------------------------------------------------- parseOutput

test('parseOutput json: parses a single document', () => {
  assert.deepEqual(parseOutput('{"a": 1}', 'json'), { a: 1 });
});

test('parseOutput json: throws on malformed input with raw output preserved', () => {
  assert.throws(() => parseOutput('not json', 'json'), (err) => {
    assert.match(err.message, /JSON/i);
    assert.equal(err.raw, 'not json');
    return true;
  });
});

test('parseOutput jsonlines: one object per line, blank lines skipped', () => {
  const text = '{"id":1}\n\n{"id":2}\n{"id":3}\n';
  assert.deepEqual(parseOutput(text, 'jsonlines'), [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test('parseOutput jsonlines: throws on a malformed line', () => {
  assert.throws(() => parseOutput('{"ok":1}\ngarbage\n', 'jsonlines'), /line 2/i);
});

test('parseOutput: rejects unknown format', () => {
  assert.throws(() => parseOutput('{}', 'xml'), /format/i);
});

// -------------------------------------------------------------- unwrapPath

test('unwrapPath: extracts the ncl {id, ok, data} envelope', () => {
  const doc = { id: 'x', ok: true, data: [{ id: 'sess-1' }] };
  assert.deepEqual(unwrapPath(doc, 'data'), [{ id: 'sess-1' }]);
});

test('unwrapPath: supports nested dot paths', () => {
  assert.deepEqual(unwrapPath({ a: { b: [1, 2] } }, 'a.b'), [1, 2]);
});

test('unwrapPath: throws when the path is missing', () => {
  assert.throws(() => unwrapPath({ ok: true }, 'data'), /data/);
});

test('unwrapPath: no path returns the value unchanged', () => {
  const rows = [{ id: 1 }];
  assert.equal(unwrapPath(rows, undefined), rows);
});
