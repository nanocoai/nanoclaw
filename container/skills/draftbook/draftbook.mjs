#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESERVED_FILES = new Set(['README.md', '_template.md', 'index.md']);

function safeId(value) {
  const id = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(id)) {
    throw new Error(
      'draft id must use 2-80 lowercase letters, numbers, dot, underscore or dash',
    );
  }
  return id;
}

function quoteYaml(value) {
  return JSON.stringify(String(value || ''));
}

function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) return {};
  const result = {};
  for (const line of content.slice(4, end).split('\n')) {
    const match = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        // Keep malformed values visible instead of silently dropping them.
      }
    }
    result[match[1]] = value;
  }
  return result;
}

export function resolveDraftbookRoot(env = process.env, cwd = process.cwd()) {
  if (env.NANOCLAW_DRAFTBOOK_DIR)
    return path.resolve(env.NANOCLAW_DRAFTBOOK_DIR);
  if (env.NANOCLAW_GLOBAL_DIR)
    return path.resolve(env.NANOCLAW_GLOBAL_DIR, 'draftbook');
  if (env.NANOCLAW_IPC_DIR) {
    const nanoclawRoot = path.resolve(env.NANOCLAW_IPC_DIR, '..', '..', '..');
    return path.join(nanoclawRoot, 'groups', 'global', 'draftbook');
  }

  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, 'groups', 'global');
    if (fs.existsSync(candidate)) return path.join(candidate, 'draftbook');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('cannot locate draftbook; set NANOCLAW_DRAFTBOOK_DIR');
}

function ensureRoot(root) {
  fs.mkdirSync(path.join(root, 'archive'), { recursive: true });
}

function readActiveMap(root) {
  const file = path.join(root, '.active.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`invalid active draft map: ${file}`);
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function listDrafts(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.md') &&
        !RESERVED_FILES.has(entry.name),
    )
    .map((entry) => {
      const filePath = path.join(root, entry.name);
      const metadata = parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
      return {
        id: metadata.id || entry.name.slice(0, -3),
        title: metadata.title || entry.name.slice(0, -3),
        project: metadata.project || '',
        status: metadata.status || 'active',
        ownerGroup: metadata.owner_group || '',
        taskId: metadata.task_id || '',
        path: filePath,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function createDraft(root, input) {
  ensureRoot(root);
  const id = safeId(input.id);
  const filePath = path.join(root, `${id}.md`);
  if (fs.existsSync(filePath)) throw new Error(`draft already exists: ${id}`);
  const today = new Date().toISOString().slice(0, 10);
  const title = String(input.title || id).trim();
  const content = `---
id: ${quoteYaml(id)}
title: ${quoteYaml(title)}
project: ${quoteYaml(input.project)}
status: active
owner_group: ${quoteYaml(input.ownerGroup)}
task_id: ${quoteYaml(input.taskId)}
created_at: ${today}
updated_at: ${today}
revision: 1
---

# ${title}

## 目标与边界

待补充。

## 当前结论

待补充。

## 待确认

- [ ] 待补充。

## 过程记录

## 下一步

- [ ] 待补充。

## 已否决方案

暂无。

## 关联资源

- task-ledger：${input.taskId || ''}
`;
  fs.writeFileSync(filePath, content, { flag: 'wx' });
  return findDraft(root, { query: id });
}

export function activateDraft(root, group, draftId) {
  if (!group) throw new Error('group is required');
  const draft = findDraft(root, { query: draftId });
  const active = readActiveMap(root);
  active[group] = draft.id;
  writeJsonAtomic(path.join(root, '.active.json'), active);
  return draft;
}

export function archiveDraft(root, draftId) {
  const draft = findDraft(root, { query: draftId });
  const archivePath = path.join(root, 'archive', `${draft.id}.md`);
  if (fs.existsSync(archivePath))
    throw new Error(`archived draft already exists: ${draft.id}`);

  const content = fs.readFileSync(draft.path, 'utf8');
  const metadata = parseFrontmatter(content);
  const revision = Number.parseInt(metadata.revision || '0', 10) || 0;
  const today = new Date().toISOString().slice(0, 10);
  const archivedContent = content
    .replace(/^status:\s*.*$/m, 'status: archived')
    .replace(/^updated_at:\s*.*$/m, `updated_at: ${today}`)
    .replace(/^revision:\s*.*$/m, `revision: ${revision + 1}`);

  fs.writeFileSync(archivePath, archivedContent, { flag: 'wx' });
  fs.unlinkSync(draft.path);

  const active = readActiveMap(root);
  let changed = false;
  for (const [group, id] of Object.entries(active)) {
    if (id !== draft.id) continue;
    delete active[group];
    changed = true;
  }
  if (changed) writeJsonAtomic(path.join(root, '.active.json'), active);

  return { ...draft, status: 'archived', path: archivePath };
}

export function getCurrentDraft(root, group) {
  if (!group) return null;
  const id = readActiveMap(root)[group];
  if (!id) return null;
  const draft = listDrafts(root).find(
    (item) => item.id === id && item.status === 'active',
  );
  return draft || null;
}

export function findDraft(root, options = {}) {
  const drafts = listDrafts(root).filter((item) => item.status === 'active');
  const query = String(options.query || '')
    .trim()
    .toLowerCase();
  const taskId = String(options.taskId || '').trim();

  if (query) {
    const exact = drafts.filter((item) =>
      [item.id, item.title, item.taskId].some(
        (value) => value.toLowerCase() === query,
      ),
    );
    if (exact.length === 1) return exact[0];
    if (exact.length > 1)
      throw new Error(`draft lookup is ambiguous: ${query}`);
  }
  if (taskId) {
    const byTask = drafts.filter((item) => item.taskId === taskId);
    if (byTask.length === 1) return byTask[0];
    if (byTask.length > 1)
      throw new Error(`task id maps to multiple drafts: ${taskId}`);
  }
  if (!query && !taskId && options.group) {
    const current = getCurrentDraft(root, options.group);
    if (current) return current;
  }
  if (query) {
    const fuzzy = drafts.filter((item) =>
      [item.id, item.title, item.project, item.taskId]
        .join('\n')
        .toLowerCase()
        .includes(query),
    );
    if (fuzzy.length === 1) return fuzzy[0];
    if (fuzzy.length > 1)
      throw new Error(`draft lookup is ambiguous: ${query}`);
  }
  if (options.group) {
    const owned = drafts.filter((item) => item.ownerGroup === options.group);
    if (owned.length === 1) return owned[0];
    if (owned.length > 1)
      throw new Error(`group has multiple active drafts: ${options.group}`);
  }
  throw new Error('draft not found');
}

function parseArgs(args) {
  const booleanOptions = new Set(['json']);
  const options = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }
    const key = arg
      .slice(2)
      .replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      if (!booleanOptions.has(key)) throw new Error(`missing value for ${arg}`);
      options[key] = true;
    } else {
      options[key] = next;
      i += 1;
    }
  }
  return options;
}

function print(value, json) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (Array.isArray(value))
    value.forEach((item) =>
      console.log(`${item.id}\t${item.title}\t${item.path}`),
    );
  else console.log(value.path || value.id || String(value));
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  const root = options.root
    ? path.resolve(options.root)
    : resolveDraftbookRoot();
  const group = options.group || process.env.NANOCLAW_GROUP_FOLDER || '';

  if (command === 'list')
    return print(listDrafts(root), options.json !== undefined);
  if (command === 'create') {
    const draft = createDraft(root, {
      id: options.id,
      title: options.title,
      project: options.project,
      ownerGroup: options.ownerGroup || group,
      taskId: options.taskId,
    });
    if (group) activateDraft(root, group, draft.id);
    return print(draft, options.json !== undefined);
  }
  if (command === 'activate')
    return print(
      activateDraft(root, group, options._[0]),
      options.json !== undefined,
    );
  if (command === 'archive')
    return print(archiveDraft(root, options._[0]), options.json !== undefined);
  if (command === 'current') {
    const current = getCurrentDraft(root, group);
    if (!current) throw new Error('current group has no active draft');
    return print(current, options.json !== undefined);
  }
  if (command === 'locate') {
    return print(
      findDraft(root, {
        query: options.query || options._[0],
        taskId: options.taskId,
        group,
      }),
      options.json !== undefined,
    );
  }
  throw new Error(
    'usage: draftbook.mjs <list|create|activate|archive|current|locate> [options]',
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
