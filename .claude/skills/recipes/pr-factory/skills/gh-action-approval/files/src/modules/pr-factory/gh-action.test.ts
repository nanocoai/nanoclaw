/**
 * gh-action-approval component guard — the modules-barrel line (`import
 * './pr-factory/gh-action-approval.js'` in src/modules/index.ts) and both
 * registrations it performs: the executor on core's gh-action seam
 * (setGhActionHandler) and the `pr_gh` approval handler
 * (registerApprovalHandler).
 *
 * Imports the REAL modules barrel and drives both registrations through
 * core's read sides: `dispatchGhAction` (the seam core's pr_gh delivery
 * action calls — falls back to an agent notification when the component is
 * absent, so the approval-card assertions go red if the barrel line is
 * deleted) and `getApprovalHandler('pr_gh')` against a PATH-shimmed fake
 * `gh` binary.
 *
 * The approval-handler cases pin: argument tokenization (quote-aware split,
 * leading `gh ` stripped), sequential stop-on-first-failure, the
 * merge-failure guidance branch, the optional PR_FACTORY_GH_REPO_ALLOWLIST
 * refusal, and the NAMESPACED gh-users mapping contract — keys are
 * `<channel>:<handle>` exactly as core reports approver ids, with NO
 * bare-id fallback, and the mapped account's token (from a HOME-sandboxed
 * ~/.config/gh/hosts.yml) reaches the subprocess as GH_TOKEN. A missing
 * data/gh-users.json must degrade to default credentials, never crash.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-prf-ghaction/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-prf-ghaction/groups',
  };
});

vi.mock('./activity-log.js', () => ({ prLog: vi.fn() }));

import type { ApprovalHandler, ApprovalHandlerContext } from '../approvals/primitive.js';
import type { Session } from '../../types.js';

const TEST_DIR = '/tmp/nanoclaw-test-prf-ghaction';
const GH_LOG = path.join(TEST_DIR, 'gh-calls.log');
const GH_TOKEN_LOG = path.join(TEST_DIR, 'gh-tokens.log');
const GH_FAIL_FLAG = path.join(TEST_DIR, 'gh-fail-flag');
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_HOME = process.env.HOME;

let ghHandler: ApprovalHandler;
let dispatchGhAction: typeof import('./gh-action.js').dispatchGhAction;
let closeDbFn: () => void;

const session: Session = {
  id: 'sess-gh',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-gh',
  thread_id: 'slack:C0GH:42.1',
  agent_provider: null,
  status: 'active',
  container_status: 'idle',
  last_active: null,
  created_at: new Date().toISOString(),
};

function ctx(
  payload: Record<string, unknown>,
  userId = 'slack:U0GOOD',
): ApprovalHandlerContext & { notify: Mock<(text: string) => void> } {
  return { session, payload, userId, notify: vi.fn<(text: string) => void>() };
}

function ghCalls(): string[] {
  if (!fs.existsSync(GH_LOG)) return [];
  return fs
    .readFileSync(GH_LOG, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/\s+$/, ''));
}

function ghTokens(): string[] {
  if (!fs.existsSync(GH_TOKEN_LOG)) return [];
  return fs.readFileSync(GH_TOKEN_LOG, 'utf8').trim().split('\n');
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_DIR, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'data'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'home', '.config', 'gh'), { recursive: true });

  // Fake gh: logs its argv tab-separated and its GH_TOKEN env, fails when
  // the flag file exists.
  const shim = [
    '#!/bin/sh',
    `LOG="${GH_LOG}"`,
    'out=""',
    'for a in "$@"; do out="$out$a\t"; done',
    'printf \'%s\\n\' "$out" >> "$LOG"',
    `printf 'TOKEN=%s\\n' "$GH_TOKEN" >> "${GH_TOKEN_LOG}"`,
    `if [ -e "${GH_FAIL_FLAG}" ]; then echo "merge blocked by branch protection" >&2; exit 1; fi`,
    'echo "gh-shim-ok"',
  ].join('\n');
  fs.writeFileSync(path.join(TEST_DIR, 'bin', 'gh'), shim, { mode: 0o755 });
  process.env.PATH = `${path.join(TEST_DIR, 'bin')}:${process.env.PATH}`;

  // HOME-sandboxed hosts.yml: the mapped account's oauth_token lives here.
  process.env.HOME = path.join(TEST_DIR, 'home');
  fs.writeFileSync(
    path.join(TEST_DIR, 'home', '.config', 'gh', 'hosts.yml'),
    [
      'github.com:',
      '    users:',
      '        mapped-gh-login:',
      '            oauth_token: gho_test_token_123',
      '    git_protocol: https',
      '',
    ].join('\n'),
  );

  // NAMESPACED mapping (D6): a correctly namespaced key for U0GOOD, plus a
  // legacy BARE key for U0BARE — which must NOT match (no strip-fallback).
  fs.writeFileSync(
    path.join(TEST_DIR, 'data', 'gh-users.json'),
    JSON.stringify({ 'slack:U0GOOD': 'mapped-gh-login', U0BARE: 'mapped-gh-login' }),
  );

  // readEnvFile resolves .env from cwd — run from a dir guaranteed to have
  // none, so a developer's real .env can't leak into the module's env reads.
  process.chdir(TEST_DIR);
  // Core must load inert (this component registers regardless of the gate).
  for (const k of ['GITHUB_WEBHOOK_SECRET', 'PR_FACTORY_SLACK_CHANNEL_ID', 'SLACK_BOT_TOKEN']) delete process.env[k];
  // The allowlist is read at module load: prime it BEFORE the barrel import.
  process.env.PR_FACTORY_GH_REPO_ALLOWLIST = 'acme/widgets';

  const dbMod = await import('../../db/index.js');
  const db = dbMod.initTestDb();
  dbMod.runMigrations(db);
  dbMod.createAgentGroup({ id: 'ag-1', name: 'W', folder: 'w', agent_provider: null, created_at: session.created_at });
  dbMod.createMessagingGroup({
    id: 'mg-gh',
    channel_type: 'slack',
    platform_id: 'slack:C0GH',
    name: null,
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: session.created_at,
  });
  const { createSession } = await import('../../db/sessions.js');
  createSession(session);
  const { initSessionFolder } = await import('../../session-manager.js');
  initSessionFolder('ag-1', 'sess-gh');
  closeDbFn = dbMod.closeDb;

  await import('../index.js'); // the REAL modules barrel — the line under guard lives here
  const { getApprovalHandler } = await import('../approvals/primitive.js');
  ghHandler = getApprovalHandler('pr_gh')!;
  expect(ghHandler, 'pr_gh approval handler not registered — barrel line missing?').toBeDefined();
  dispatchGhAction = (await import('./gh-action.js')).dispatchGhAction;
});

afterAll(() => {
  closeDbFn?.();
  process.chdir(ORIGINAL_CWD);
  process.env.PATH = ORIGINAL_PATH;
  process.env.HOME = ORIGINAL_HOME;
  delete process.env.PR_FACTORY_GH_REPO_ALLOWLIST;
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(GH_LOG, { force: true });
  fs.rmSync(GH_TOKEN_LOG, { force: true });
  fs.rmSync(GH_FAIL_FLAG, { force: true });
});

describe('gh-action seam registration (dispatch reaches the installed executor)', () => {
  it('dispatchGhAction posts the preview + approval card instead of the not-installed fallback', async () => {
    type Delivered = { kind: string; content: Record<string, unknown>; instance?: string };
    const delivered: Delivered[] = [];
    const { setDeliveryAdapter } = await import('../../delivery.js');
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, kind, content, _files, instance) {
        delivered.push({ kind, content: JSON.parse(content) as Record<string, unknown>, instance });
        return `plat-${delivered.length}`;
      },
    });

    await dispatchGhAction({ commands: ['gh pr view 42'], description: 'view the PR' }, session);

    expect(delivered).toHaveLength(2);
    expect(delivered[0].kind).toBe('chat');
    expect(String(delivered[0].content.text)).toContain('view the PR');
    expect(delivered[1].kind).toBe('chat-sdk');
    expect(delivered[1].content.type).toBe('ask_question');
    expect(String(delivered[1].content.question)).toContain('gh pr view 42');
    // The card routes through the messaging group's instance (worker default).
    expect(delivered[1].instance).toBe('slack');

    const { getPendingApprovalsBySessionAction, deletePendingApprovalsBySessionAction } =
      await import('../../db/sessions.js');
    const pending = getPendingApprovalsBySessionAction('sess-gh', 'pr_gh');
    expect(pending).toHaveLength(1);
    expect(JSON.parse(pending[0].payload!)).toEqual({ commands: ['gh pr view 42'], description: 'view the PR' });
    deletePendingApprovalsBySessionAction('sess-gh', 'pr_gh');
  });
});

describe('pr_gh approval handler', () => {
  it('tokenizes the command (strips leading gh, keeps quoted args whole) and reports success', async () => {
    const c = ctx({ commands: ['gh pr comment 42 --body "hello world"'], description: 'comment' });
    await ghHandler(c);

    expect(ghCalls()).toEqual(['pr\tcomment\t42\t--body\thello world']);
    expect(c.notify).toHaveBeenCalledTimes(1);
    expect(String(c.notify.mock.calls[0][0])).toContain('succeeded');
  });

  it('maps a NAMESPACED approver id to gh credentials (GH_TOKEN from the sandboxed hosts.yml)', async () => {
    const c = ctx({ commands: ['gh pr view 42'], description: 'view' }, 'slack:U0GOOD');
    await ghHandler(c);

    expect(ghCalls()).toEqual(['pr\tview\t42']);
    expect(ghTokens()).toEqual(['TOKEN=gho_test_token_123']);
  });

  it('does NOT strip-match a bare legacy key — unmapped approvers run with default credentials', async () => {
    // gh-users.json has the BARE key "U0BARE"; the click reports "slack:U0BARE".
    const c = ctx({ command: 'gh pr view 42', description: 'view' }, 'slack:U0BARE');
    await ghHandler(c);

    expect(ghCalls()).toEqual(['pr\tview\t42']); // legacy single `command` string still executes
    expect(ghTokens()).toEqual(['TOKEN=']);
  });

  it('stops on first failure and surfaces merge-failure guidance', async () => {
    fs.writeFileSync(GH_FAIL_FLAG, '1');
    const c = ctx({
      commands: ['gh pr merge 42 --squash', 'gh pr comment 42 --body "after"'],
      description: 'merge then comment',
    });
    await ghHandler(c);

    // Only the first command ran.
    expect(ghCalls()).toEqual(['pr\tmerge\t42\t--squash']);
    const text = String(c.notify.mock.calls[0][0]);
    expect(text).toContain('failed');
    expect(text).toContain('branch protection');
    expect(text).not.toContain('after');
  });

  it('refuses a command referencing a repo outside PR_FACTORY_GH_REPO_ALLOWLIST before executing it', async () => {
    const c = ctx({
      commands: ['gh api repos/evil/exfil/dispatches', 'gh pr comment 42 --body "after"'],
      description: 'api call',
    });
    await ghHandler(c);

    expect(ghCalls()).toEqual([]); // nothing executed
    const text = String(c.notify.mock.calls[0][0]);
    expect(text).toContain('refused');
    expect(text).toContain('evil/exfil');
  });

  it('allowlisted repo references pass', async () => {
    const c = ctx({ commands: ['gh pr merge 42 -R acme/widgets'], description: 'merge' });
    await ghHandler(c);
    expect(ghCalls()).toEqual(['pr\tmerge\t42\t-R\tacme/widgets']);
  });

  it('a missing data/gh-users.json degrades to default credentials without crashing', async () => {
    // Fresh module generation with no mapping file: the import and the
    // handler must both survive its absence (lazy + fail-soft read).
    vi.resetModules();
    fs.rmSync(path.join(TEST_DIR, 'data', 'gh-users.json'), { force: true });

    const dbMod = await import('../../db/index.js');
    const db = dbMod.initTestDb();
    dbMod.runMigrations(db);
    try {
      await import('../index.js');
      const { getApprovalHandler } = await import('../approvals/primitive.js');
      const handler = getApprovalHandler('pr_gh')!;
      expect(handler).toBeDefined();

      const c = ctx({ command: 'gh pr view 7', description: 'view' });
      await handler(c);

      expect(ghCalls()).toEqual(['pr\tview\t7']);
      expect(ghTokens()).toEqual(['TOKEN=']);
      expect(String(c.notify.mock.calls[0][0])).toContain('succeeded');
    } finally {
      dbMod.closeDb();
    }
  });
});
