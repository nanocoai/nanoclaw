import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globFiles, describeFile, resolveDoc } from '../docs.js';

let root;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'clidash-docs-'));
  const w = (rel, body = 'x') => {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  };
  w('groups/alpha/skills/example-skill/SKILL.md', '# example-skill\nbody');
  w('groups/alpha/skills/tagger/SKILL.md');
  w('groups/alpha/CLAUDE.md', '# Alpha');
  w('groups/alpha/CLAUDE.local.md');
  w('groups/alpha/profile.json', '{"name":"Alpha"}');
  w('groups/alpha/conversations/2026-06-01.md');
  w('groups/bravo/skills/tagger/SKILL.md');
  w('groups/bravo/profile.json');
  w('container/skills/agent-browser/SKILL.md');
  w('container/skills/welcome/SKILL.md');
  // things that must NEVER be served
  w('groups/alpha/.env', 'SECRET=1');
  w('groups/alpha/skills/example-skill/node_modules/dep/SKILL.md');
  w('groups/alpha/notion-token.txt', 'ntn_xxx');
});

after(() => rmSync(root, { recursive: true, force: true }));

const DENY = ['node_modules', '.env', '*token*', '*secret*', '*.pem', '*.key'];

// --------------------------------------------------------------- globFiles

test('globFiles: matches a nested *-segment pattern', () => {
  const files = globFiles(root, ['groups/*/skills/*/SKILL.md'], DENY);
  assert.deepEqual(files, [
    'groups/alpha/skills/example-skill/SKILL.md',
    'groups/alpha/skills/tagger/SKILL.md',
    'groups/bravo/skills/tagger/SKILL.md',
  ]);
});

test('globFiles: multiple patterns union, sorted', () => {
  const files = globFiles(root, ['groups/*/skills/*/SKILL.md', 'container/skills/*/SKILL.md'], DENY);
  assert.ok(files.includes('container/skills/agent-browser/SKILL.md'));
  assert.ok(files.includes('groups/alpha/skills/example-skill/SKILL.md'));
});

test('globFiles: wildcard inside a filename segment', () => {
  const files = globFiles(root, ['groups/*/CLAUDE*.md'], DENY);
  assert.deepEqual(files, ['groups/alpha/CLAUDE.local.md', 'groups/alpha/CLAUDE.md']);
});

test('globFiles: deny list excludes node_modules and secret-ish files', () => {
  const files = globFiles(root, ['groups/*/skills/*/**', 'groups/*/*'], DENY);
  assert.ok(!files.some((f) => f.includes('node_modules')));
  assert.ok(!files.some((f) => f.endsWith('.env')));
  assert.ok(!files.some((f) => f.includes('token')));
});

test('globFiles: no match returns empty array', () => {
  assert.deepEqual(globFiles(root, ['nope/*/x.md'], DENY), []);
});

// ------------------------------------------------------------- describeFile

test('describeFile: per-group skill → group + readable label', () => {
  const d = describeFile('groups/alpha/skills/tagger/SKILL.md');
  assert.equal(d.group, 'alpha');
  assert.match(d.label, /alpha/);
  assert.match(d.label, /tagger/);
});

test('describeFile: container skill → shared', () => {
  const d = describeFile('container/skills/agent-browser/SKILL.md');
  assert.equal(d.group, 'shared');
  assert.match(d.label, /agent-browser/);
});

// --------------------------------------------------------------- resolveDoc

const SKILLS = { name: 'skills', patterns: ['groups/*/skills/*/SKILL.md', 'container/skills/*/SKILL.md'] };

test('resolveDoc: returns an absolute path for an allowed file', () => {
  const abs = resolveDoc(root, SKILLS, 'groups/alpha/skills/example-skill/SKILL.md', DENY);
  assert.ok(abs.endsWith('/groups/alpha/skills/example-skill/SKILL.md'));
  assert.ok(abs.startsWith(root));
});

test('resolveDoc: rejects a path not matching the collection patterns', () => {
  assert.throws(() => resolveDoc(root, SKILLS, 'groups/alpha/profile.json', DENY), /not allowed/i);
});

test('resolveDoc: rejects path traversal', () => {
  assert.throws(() => resolveDoc(root, SKILLS, '../../etc/passwd', DENY), /not allowed/i);
  assert.throws(() => resolveDoc(root, SKILLS, 'groups/alpha/skills/../../../.env', DENY), /not allowed/i);
});

test('resolveDoc: rejects an absolute path', () => {
  assert.throws(() => resolveDoc(root, SKILLS, '/etc/passwd', DENY), /not allowed/i);
});

test('resolveDoc: a denied file is not resolvable even if pattern-shaped', () => {
  const coll = { name: 'all', patterns: ['groups/*/*'] };
  assert.throws(() => resolveDoc(root, coll, 'groups/alpha/.env', DENY), /not allowed/i);
});
