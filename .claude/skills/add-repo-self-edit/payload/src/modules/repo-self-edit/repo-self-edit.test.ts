/**
 * Repo self-edit — integration with the guard, approvals and delivery seams.
 *
 * Registration is asserted through the real modules barrel. The approval
 * flow runs end to end against the real central DB, a fake delivery adapter
 * and a throwaway git repo standing in for the install: dispatch → guard
 * hold → card → approval handler → guarded replay → commit / gate / revert.
 * Only the out-of-process steps (typecheck, watchdog spawn), the container
 * restart and the upgrade stamp are faked.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-repo-self-edit-data' };
});
vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});
vi.mock('../../container-runner.js', () => ({ wakeContainer: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));
vi.mock('../../container-restart.js', () => ({ restartAgentGroupContainers: vi.fn().mockResolvedValue(1) }));
vi.mock('../../upgrade-state.js', () => ({ writeUpgradeState: vi.fn() }));
vi.mock('./checks.js', () => ({
  runContainerCheck: vi.fn().mockResolvedValue({ ok: true }),
  spawnWatchdog: vi.fn(),
}));

import '../index.js';

import { restartAgentGroupContainers } from '../../container-restart.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getPendingApprovalsByAction } from '../../db/sessions.js';
import { getDeliveryAction, setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { guard, listGuardedActions } from '../../guard/index.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { writeUpgradeState } from '../../upgrade-state.js';
import { getApprovalHandler } from '../approvals/primitive.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';
import { runContainerCheck, spawnWatchdog } from './checks.js';
import { ALLOWLIST_ENV, repoSelfEditApply } from './guard.js';
import { reportWatchdogResult } from './index.js';
import { isLocked, resultPath } from './state.js';

const DATA_DIR = '/tmp/nanoclaw-test-repo-self-edit-data';
const now = () => new Date().toISOString();
const agent = { kind: 'agent', agentGroupId: 'ag-1', sessionId: 'sess-1' } as const;

let repo: string;
let session: Session;
let delivered: string[];

const fakeAdapter: ChannelDeliveryAdapter = {
  async deliver(_channelType, _platformId, _threadId, _kind, content) {
    delivered.push(content);
    return 'pm-1';
  },
};

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
}

function read(file: string): string {
  return fs.readFileSync(path.join(repo, file), 'utf8');
}

/** A git-format patch changing `file` to `next`, leaving the working tree untouched. */
function patchFor(file: string, next: string): string {
  const before = read(file);
  write(file, next);
  const diff = git('diff', '--', file);
  write(file, before);
  return diff;
}

function notes(): string[] {
  return vi.mocked(writeSessionMessage).mock.calls.map((c) => (JSON.parse(c[2].content) as { text: string }).text);
}

async function propose(diff: string, reason = 'test change'): Promise<void> {
  await getDeliveryAction('repo_self_edit')!({ action: 'repo_self_edit', diff, reason }, session);
}

/** Approve the one pending card, exactly as the approvals response path does. */
async function approvePending(): Promise<void> {
  const [row] = await getPendingApprovalsByAction('repo_self_edit');
  expect(row).toBeDefined();
  await getApprovalHandler('repo_self_edit')!({
    session,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    approval: row,
    userId: 'slack:admin-1',
    notify: async () => {},
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  delivered = [];
  process.env[ALLOWLIST_ENV] = 'ag-1';

  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-self-edit-'));
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  write('.gitignore', 'data/\n.env\ndocs/private/\n');
  write('src/router.ts', 'export const a = 1;\n');
  write('src/guard/guard.ts', 'export const g = 1;\n');
  write('container/agent-runner/src/tool.ts', 'export const t = 1;\n');
  write('docs/guide.md', '# Guide\n');
  write('package.json', '{}\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  vi.spyOn(process, 'cwd').mockReturnValue(repo);

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  await createSession(session);
  await upsertUser({ id: 'slack:admin-1', kind: 'slack', display_name: 'Admin', created_at: now() });
  await grantRole({
    user_id: 'slack:admin-1',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-dm-1',
    channel_type: 'slack',
    platform_id: 'D-admin-1',
    name: 'Admin DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({
    user_id: 'slack:admin-1',
    channel_type: 'slack',
    messaging_group_id: 'mg-dm-1',
    resolved_at: now(),
  });
  setDeliveryAdapter(fakeAdapter);
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env[ALLOWLIST_ENV];
  await closeDb();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('registration through the modules barrel', () => {
  it('registers the guarded delivery action, its approval continuation and its catalog entry', () => {
    expect(getDeliveryAction('repo_self_edit')).toBeTypeOf('function');
    expect(getApprovalHandler('repo_self_edit')).toBeTypeOf('function');
    const entry = listGuardedActions().find((a) => a.action === 'repo_self_edit.apply');
    expect(entry?.grantActionName).toBe('repo_self_edit');
  });
});

describe('guard decision', () => {
  it('holds for admin approval when the agent group is opted in', async () => {
    expect((await guard(repoSelfEditApply, { actor: agent, payload: {} })).effect).toBe('hold');
  });

  it('denies agent groups that are not listed, naming the setting', async () => {
    process.env[ALLOWLIST_ENV] = 'ag-other';
    const decision = await guard(repoSelfEditApply, { actor: agent, payload: {} });
    expect(decision.effect).toBe('deny');
    expect(decision.reason).toContain(ALLOWLIST_ENV);
  });

  it('denies non-agent callers', async () => {
    expect((await guard(repoSelfEditApply, { actor: { kind: 'host' }, payload: {} })).effect).toBe('deny');
  });

  it('a grant cannot resurrect a group removed from the list', async () => {
    process.env[ALLOWLIST_ENV] = '';
    const grant = { approval_id: 'appr-1', action: 'repo_self_edit', payload: '{}' } as unknown as PendingApproval;
    expect((await guard(repoSelfEditApply, { actor: agent, payload: {}, grant })).effect).toBe('deny');
  });
});

describe('proposal → approval → apply', () => {
  it('cards the whole patch, and on approval commits only the patched file', async () => {
    write('src/unrelated.ts', 'work in progress\n');
    write('src/staged.ts', 'staged elsewhere\n');
    git('add', 'src/staged.ts');
    const diff = patchFor('container/agent-runner/src/tool.ts', 'export const t = 2;\n');

    await propose(diff, 'bump t');
    expect(delivered).toHaveLength(1);
    const question = (JSON.parse(delivered[0]) as { question: string }).question;
    expect(question).toContain('+export const t = 2;');
    expect(question).toContain('bump t');
    expect(read('container/agent-runner/src/tool.ts')).toBe('export const t = 1;\n');

    await approvePending();

    expect(read('container/agent-runner/src/tool.ts')).toBe('export const t = 2;\n');
    expect(git('log', '-1', '--format=%s')).toBe('self-edit: bump t\n');
    expect(git('show', '--name-only', '--format=', 'HEAD').trim()).toBe('container/agent-runner/src/tool.ts');
    expect(git('status', '--porcelain')).toContain('?? src/unrelated.ts');
    expect(git('status', '--porcelain')).toContain('A  src/staged.ts');
    expect(writeUpgradeState).toHaveBeenCalledWith(
      expect.objectContaining({ via: 'repo-self-edit', projectRoot: repo }),
    );
    expect(runContainerCheck).toHaveBeenCalledWith(repo);
    expect(restartAgentGroupContainers).toHaveBeenCalledWith('ag-1', 'repo self-edit applied', expect.any(String));
    expect(spawnWatchdog).not.toHaveBeenCalled();
  });

  it('reverts the commit when the agent-runner typecheck fails', async () => {
    vi.mocked(runContainerCheck).mockResolvedValueOnce({ ok: false, output: 'TS2322: nope' });
    write('src/staged.ts', 'staged elsewhere\n');
    git('add', 'src/staged.ts');
    await propose(patchFor('container/agent-runner/src/tool.ts', 'export const t: string = 2;\n'));
    await approvePending();

    expect(read('container/agent-runner/src/tool.ts')).toBe('export const t = 1;\n');
    expect(git('log', '-1', '--format=%s')).toMatch(/^Revert "self-edit: /);
    expect(writeUpgradeState).toHaveBeenCalledWith(expect.objectContaining({ via: 'repo-self-edit-revert' }));
    expect(git('show', '--name-only', '--format=', 'HEAD').trim()).toBe('container/agent-runner/src/tool.ts');
    expect(git('status', '--porcelain')).toContain('A  src/staged.ts');
    expect(restartAgentGroupContainers).not.toHaveBeenCalled();
    expect(notes().at(-1)).toContain('TS2322');
  });

  it('hands host edits to the watchdog and reports its verdict from the host', async () => {
    await propose(patchFor('src/router.ts', 'export const a = 2;\n'));
    await approvePending();

    const sha = git('rev-parse', 'HEAD').trim();
    expect(spawnWatchdog).toHaveBeenCalledWith(repo, sha, 'sess-1');
    expect(isLocked(repo)).toBe(true);
    expect(restartAgentGroupContainers).not.toHaveBeenCalled();

    fs.writeFileSync(
      resultPath(repo),
      JSON.stringify({ ok: false, sessionId: 'sess-1', newSha: sha, revertSha: 'abc123', detail: 'build failed' }),
    );
    await reportWatchdogResult(repo);
    expect(notes().at(-1)).toContain('reverted with abc123');
    expect(isLocked(repo)).toBe(false);
    expect(fs.existsSync(resultPath(repo))).toBe(false);
  });

  it('commits docs-only edits without restarting anything', async () => {
    await propose(patchFor('docs/guide.md', '# Guide\n\nMore.\n'));
    await approvePending();
    expect(read('docs/guide.md')).toContain('More.');
    expect(runContainerCheck).not.toHaveBeenCalled();
    expect(restartAgentGroupContainers).not.toHaveBeenCalled();
    expect(spawnWatchdog).not.toHaveBeenCalled();
  });

  it('re-checks the patch on the approved replay against the tree as it is then', async () => {
    await propose(patchFor('src/router.ts', 'export const a = 2;\n'));
    write('src/router.ts', 'export const a = 3;\n'); // the operator edits the file meanwhile
    await approvePending();
    expect(read('src/router.ts')).toBe('export const a = 3;\n');
    expect(git('log', '-1', '--format=%s')).toBe('base\n');
    expect(notes().at(-1)).toContain('uncommitted changes');
  });
});

describe('refused before any card is minted', () => {
  const cases: Array<[string, () => string, string]> = [
    ['a protected file', () => patchFor('src/guard/guard.ts', 'export const g = 2;\n'), 'protected'],
    ['a path outside the editable prefixes', () => patchFor('package.json', '{"x":1}\n'), 'outside the editable'],
    [
      'an env file',
      () =>
        'diff --git a/src/.env b/src/.env\nnew file mode 100644\n--- /dev/null\n+++ b/src/.env\n@@ -0,0 +1 @@\n+K=v\n',
      'env file',
    ],
    [
      'a git-ignored path',
      () =>
        'diff --git a/docs/private/x.md b/docs/private/x.md\nnew file mode 100644\n--- /dev/null\n+++ b/docs/private/x.md\n@@ -0,0 +1 @@\n+x\n',
      'ignored by git',
    ],
    [
      'a rename',
      () =>
        'diff --git a/src/router.ts b/src/other.ts\nsimilarity index 100%\nrename from src/router.ts\nrename to src/other.ts\n',
      'renames',
    ],
    [
      'a symlink',
      () =>
        'diff --git a/src/link b/src/link\nnew file mode 120000\n--- /dev/null\n+++ b/src/link\n@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n',
      'non-regular file',
    ],
    [
      'a patch that does not apply',
      () =>
        'diff --git a/src/router.ts b/src/router.ts\n--- a/src/router.ts\n+++ b/src/router.ts\n@@ -1 +1 @@\n-nope\n+x\n',
      'does not apply',
    ],
    ['a plain unified diff', () => '--- a/src/router.ts\n+++ b/src/router.ts\n@@ -1 +1 @@\n-a\n+b\n', 'diff --git'],
  ];

  it.each(cases)('%s', async (_name, makeDiff, expected) => {
    await propose(makeDiff());
    expect(delivered).toHaveLength(0);
    expect(await getPendingApprovalsByAction('repo_self_edit')).toHaveLength(0);
    expect(notes().at(-1)).toContain(expected);
  });

  it('a file with uncommitted operator changes', async () => {
    const diff = patchFor('src/router.ts', 'export const a = 2;\n');
    write('src/router.ts', 'export const a = 9;\n');
    await propose(diff);
    expect(delivered).toHaveLength(0);
    expect(notes().at(-1)).toContain('uncommitted changes');
  });

  it('a patch too large to show in full on one card', async () => {
    await propose(patchFor('docs/guide.md', `# Guide\n${'line of text\n'.repeat(400)}`));
    expect(delivered).toHaveLength(0);
    expect(notes().at(-1)).toContain('split the change');
  });

  it('a group that is not opted in', async () => {
    process.env[ALLOWLIST_ENV] = '';
    await propose(patchFor('src/router.ts', 'export const a = 2;\n'));
    expect(delivered).toHaveLength(0);
    expect(notes().at(-1)).toContain('denied');
  });
});
