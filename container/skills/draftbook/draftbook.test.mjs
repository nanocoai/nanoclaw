import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  activateDraft,
  archiveDraft,
  createDraft,
  findDraft,
  getCurrentDraft,
  listDrafts,
  resolveDraftbookRoot,
} from './draftbook.mjs';

function withDraftbook(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draftbook-'));
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('创建任务草稿并拒绝重复 ID', () =>
  withDraftbook((root) => {
    const created = createDraft(root, {
      id: 'task-a',
      title: '任务 A',
      project: 'nanoclaw',
      ownerGroup: 'group-a',
      taskId: 'tl-a',
    });

    assert.equal(path.basename(created.path), 'task-a.md');
    assert.equal(listDrafts(root).length, 1);
    assert.throws(
      () => createDraft(root, { id: 'task-a', title: '重复任务' }),
      /already exists/,
    );
  }));

test('当前群映射能稳定找到同一份草稿', () =>
  withDraftbook((root) => {
    createDraft(root, { id: 'task-a', title: '任务 A', ownerGroup: 'group-a' });
    createDraft(root, { id: 'task-b', title: '任务 B', ownerGroup: 'group-a' });
    activateDraft(root, 'group-a', 'task-b');

    assert.equal(getCurrentDraft(root, 'group-a').id, 'task-b');
    assert.equal(findDraft(root, { group: 'group-a' }).id, 'task-b');
  }));

test('显式 ID 或 task ID 优先于当前群映射', () =>
  withDraftbook((root) => {
    createDraft(root, {
      id: 'task-a',
      title: '任务 A',
      ownerGroup: 'group-a',
      taskId: 'tl-a',
    });
    createDraft(root, { id: 'task-b', title: '任务 B', ownerGroup: 'group-a' });
    activateDraft(root, 'group-a', 'task-b');

    assert.equal(
      findDraft(root, { query: 'task-a', group: 'group-a' }).id,
      'task-a',
    );
    assert.equal(
      findDraft(root, { taskId: 'tl-a', group: 'group-a' }).id,
      'task-a',
    );
  }));

test('模糊查询命中多个任务时拒绝猜测', () =>
  withDraftbook((root) => {
    createDraft(root, { id: 'oauth-api', title: 'OAuth API' });
    createDraft(root, { id: 'oauth-web', title: 'OAuth Web' });

    assert.throws(() => findDraft(root, { query: 'oauth' }), /ambiguous/);
  }));

test('CLI 的 --json 是无值布尔参数', () =>
  withDraftbook((root) => {
    createDraft(root, { id: 'task-a', title: '任务 A' });
    const output = execFileSync(
      process.execPath,
      [
        new URL('./draftbook.mjs', import.meta.url).pathname,
        'locate',
        '--root',
        root,
        '--query',
        'task-a',
        '--json',
      ],
      { encoding: 'utf8' },
    );

    assert.equal(JSON.parse(output).id, 'task-a');
  }));

test('CLI 的值参数缺失时明确失败', () =>
  withDraftbook((root) => {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            new URL('./draftbook.mjs', import.meta.url).pathname,
            'create',
            '--root',
            root,
            '--id',
          ],
          { encoding: 'utf8', stdio: 'pipe' },
        ),
      (error) => error.stderr.includes('missing value for --id'),
    );
  }));

test('根据 NANOCLAW_IPC_DIR 定位全局草稿本', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-root-'));
  try {
    const ipcDir = path.join(root, 'data', 'ipc', 'group-a');
    assert.equal(
      resolveDraftbookRoot({ NANOCLAW_IPC_DIR: ipcDir }, '/'),
      path.join(root, 'groups', 'global', 'draftbook'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('NANOCLAW_GLOBAL_DIR 优先指定草稿本位置', () => {
  assert.equal(
    resolveDraftbookRoot({
      NANOCLAW_DRAFTBOOK_DIR: '',
      NANOCLAW_GLOBAL_DIR: '/runtime/global',
      NANOCLAW_IPC_DIR: '/unrelated/ipc',
    }),
    '/runtime/global/draftbook',
  );
});

test('归档草稿后清除当前群映射且不再参与定位', () =>
  withDraftbook((root) => {
    createDraft(root, { id: 'task-a', title: '任务 A', ownerGroup: 'group-a' });
    activateDraft(root, 'group-a', 'task-a');

    const archived = archiveDraft(root, 'task-a');

    assert.equal(archived.status, 'archived');
    assert.equal(path.basename(archived.path), 'task-a.md');
    assert.equal(path.basename(path.dirname(archived.path)), 'archive');
    assert.equal(getCurrentDraft(root, 'group-a'), null);
    assert.throws(() => findDraft(root, { query: 'task-a' }), /not found/);
  }));
