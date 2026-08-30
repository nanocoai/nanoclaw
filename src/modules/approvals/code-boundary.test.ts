/**
 * Host half of D17's detached boundary confirm: request file → card → click →
 * decision file; expiry denies before the hook's own ceiling; the restart
 * sweep denies orphans; malformed requests fail closed.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-code-boundary' };
});

const TEST_DIR = '/tmp/nanoclaw-test-code-boundary';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createPendingApproval, createSession, getPendingApprovalsByAction, updateSession } from '../../db/sessions.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import { initSessionFolder, sessionDir } from '../../session-manager.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { handleApprovalsResponse } from './response-handler.js';
import { BOUNDARY_DECISIONS_SUBDIR } from '../../code-mode/permissions.js';
import {
  BOUNDARY_FILE_MAX_AGE_MS,
  BOUNDARY_SUBDIR,
  CODE_BOUNDARY_ACTION,
  HOST_EXPIRY_MS,
  scanCodeBoundaryRequests,
  startCodeBoundaryWatcher,
  stopCodeBoundaryWatcher,
  sweepAgedBoundaryFiles,
} from './code-boundary.js';

const GID = 'ag-boundary';
const SID = 'sess-boundary';
const ADMIN = 'slack:admin-1';

function now(): string {
  return new Date().toISOString();
}

function makeAdapter(): ChannelDeliveryAdapter & { deliver: ReturnType<typeof vi.fn> } {
  return { deliver: vi.fn().mockResolvedValue('msg-1') } as unknown as ChannelDeliveryAdapter & {
    deliver: ReturnType<typeof vi.fn>;
  };
}

function boundaryDir(): string {
  return path.join(sessionDir(GID, SID), BOUNDARY_SUBDIR);
}

function seedRequest(id: string, at: string = now()): string {
  fs.mkdirSync(boundaryDir(), { recursive: true });
  const file = path.join(boundaryDir(), `${id}.request.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      id,
      toolName: 'Bash',
      toolInput: { command: 'ncl envs release env-1' },
      reason: 'dev-env release',
      at,
    }),
  );
  return file;
}

function decisionsDir(): string {
  // The RO-mounted half: decisions land beside, never inside, the RW request
  // dir — the agent reads them through the mount and can write neither.
  return path.join(sessionDir(GID, SID), BOUNDARY_DECISIONS_SUBDIR);
}

function decisionFileFor(id: string): string {
  return path.join(decisionsDir(), `${id}.decision.json`);
}

function readDecision(id: string): { decision: string; reason?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(decisionFileFor(id), 'utf8'));
  } catch {
    return null;
  }
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());

  await createAgentGroup({
    id: GID,
    name: 'Boundary Agent',
    folder: 'boundary',
    agent_provider: null,
    created_at: now(),
  });
  await createSession({
    id: SID,
    agent_group_id: GID,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now(),
    created_at: now(),
  });
  initSessionFolder(GID, SID);

  // A clicking admin with a cached DM so pickApprovalDelivery resolves
  // without a live platform.
  await upsertUser({ id: ADMIN, kind: 'slack', display_name: 'Admin', created_at: now() });
  await grantRole({ user_id: ADMIN, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  await createMessagingGroup({
    id: 'mg-admin-dm',
    channel_type: 'slack',
    platform_id: 'D-admin',
    name: 'dm',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({ user_id: ADMIN, channel_type: 'slack', messaging_group_id: 'mg-admin-dm', resolved_at: now() });
});

afterEach(async () => {
  stopCodeBoundaryWatcher();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('request → card → click → decision file', () => {
  it('allow: the click writes the decision the hook is polling for', async () => {
    const adapter = makeAdapter();
    startCodeBoundaryWatcher(adapter);
    seedRequest('11111111-aaaa-bbbb-cccc-000000000001');
    await scanCodeBoundaryRequests();

    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    const card = JSON.parse(adapter.deliver.mock.calls[0][4] as string);
    expect(card.type).toBe('ask_question');
    expect(card.question).toContain('dev-env release');
    expect(card.question).toContain('Boundary Agent');

    const row = (await getPendingApprovalsByAction(CODE_BOUNDARY_ACTION))[0];
    expect(row.session_id).toBe(SID);
    expect(row.agent_group_id).toBe(GID);
    // Expiry sits inside the hook's own ceiling, measured from the REQUEST stamp.
    expect(Date.parse(row.expires_at!)).toBeLessThanOrEqual(Date.now() + HOST_EXPIRY_MS);

    const claimed = await handleApprovalsResponse({
      questionId: card.questionId,
      value: 'approve',
      userId: ADMIN,
      channelType: 'slack',
      platformId: 'D-admin',
      threadId: null,
    });
    expect(claimed).toBe(true);
    expect(readDecision('11111111-aaaa-bbbb-cccc-000000000001')).toEqual({
      decision: 'allow',
      reason: 'allow by approver',
    });
    expect(await getPendingApprovalsByAction(CODE_BOUNDARY_ACTION)).toEqual([]);
  });

  it('deny: any non-approve click is a deny', async () => {
    const adapter = makeAdapter();
    startCodeBoundaryWatcher(adapter);
    seedRequest('11111111-aaaa-bbbb-cccc-000000000002');
    await scanCodeBoundaryRequests();
    const card = JSON.parse(adapter.deliver.mock.calls[0][4] as string);

    await handleApprovalsResponse({
      questionId: card.questionId,
      value: 'deny',
      userId: ADMIN,
      channelType: 'slack',
      platformId: 'D-admin',
      threadId: null,
    });
    expect(readDecision('11111111-aaaa-bbbb-cccc-000000000002')?.decision).toBe('deny');
  });

  it('a request is routed exactly once across scans', async () => {
    const adapter = makeAdapter();
    startCodeBoundaryWatcher(adapter);
    seedRequest('11111111-aaaa-bbbb-cccc-000000000003');
    await scanCodeBoundaryRequests();
    await scanCodeBoundaryRequests();
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
  });

  it('sessions without a boundary dir (chat mode) are skipped untouched', async () => {
    const adapter = makeAdapter();
    startCodeBoundaryWatcher(adapter);
    await scanCodeBoundaryRequests();
    expect(adapter.deliver).not.toHaveBeenCalled();
    // And a stopped session's dir is not scanned.
    await updateSession(SID, { container_status: 'stopped' });
    seedRequest('11111111-aaaa-bbbb-cccc-000000000004');
    await scanCodeBoundaryRequests();
    expect(adapter.deliver).not.toHaveBeenCalled();
  });
});

describe('failing closed', () => {
  it('an already-expired request gets an immediate deny and no card', async () => {
    const adapter = makeAdapter();
    startCodeBoundaryWatcher(adapter);
    const staleAt = new Date(Date.now() - HOST_EXPIRY_MS - 1000).toISOString();
    seedRequest('11111111-aaaa-bbbb-cccc-000000000005', staleAt);
    await scanCodeBoundaryRequests();
    expect(adapter.deliver).not.toHaveBeenCalled();
    expect(readDecision('11111111-aaaa-bbbb-cccc-000000000005')?.decision).toBe('deny');
  });

  it('a malformed timestamp is denied; an id failing the charset is refused without a path build', async () => {
    const adapter = makeAdapter();
    startCodeBoundaryWatcher(adapter);
    const requestFile = seedRequest('11111111-aaaa-bbbb-cccc-000000000006', 'not-a-time');
    await scanCodeBoundaryRequests();
    expect(readDecision('11111111-aaaa-bbbb-cccc-000000000006')?.decision).toBe('deny');
    expect(adapter.deliver).not.toHaveBeenCalled();
    // A refused request cannot resolve, so the host clears it — the hook only
    // ever deletes requests it saw decided.
    expect(fs.existsSync(requestFile)).toBe(false);

    // Path-shaped id: never trusted, never written anywhere.
    fs.writeFileSync(
      path.join(boundaryDir(), 'evil.request.json'),
      JSON.stringify({ id: '../../escape', toolName: 'Bash', toolInput: {}, reason: 'x', at: now() }),
    );
    await scanCodeBoundaryRequests();
    expect(fs.existsSync(path.join(sessionDir(GID, SID), '..', '..', 'escape.decision.json'))).toBe(false);
    expect(adapter.deliver).not.toHaveBeenCalled();
  });

  it('an unreadable request body still gets its deny, addressed by the filename id', async () => {
    // The hook mints the filename from the same id it puts in the body
    // (boundary.ts requestPath), so a corrupt body must not cost the blocked
    // hook its explicit deny — silence would be the full-TTL wait the
    // routeRequest comment promises against (E-t7 review).
    const adapter = makeAdapter();
    startCodeBoundaryWatcher(adapter);
    fs.mkdirSync(boundaryDir(), { recursive: true });
    const requestFile = path.join(boundaryDir(), '11111111-aaaa-bbbb-cccc-00000000000a.request.json');
    fs.writeFileSync(requestFile, '{"id": "11111');
    await scanCodeBoundaryRequests();
    expect(readDecision('11111111-aaaa-bbbb-cccc-00000000000a')?.decision).toBe('deny');
    expect(adapter.deliver).not.toHaveBeenCalled();
    expect(fs.existsSync(requestFile)).toBe(false);

    // A filename failing the charset gets nothing — no id anywhere to trust.
    const evil = path.join(boundaryDir(), 'no~such~id.request.json');
    fs.writeFileSync(evil, '{"tor');
    await scanCodeBoundaryRequests();
    expect(fs.readdirSync(decisionsDir()).filter((f) => f.includes('no~such~id'))).toEqual([]);
  });

  it('the age sweep clears decisions the hook cannot delete and requests of dead hooks', () => {
    // The hook cannot delete from the RO decisions mount, and a killed hook
    // orphans its request — the sweep is the hygiene half of the pair.
    fs.mkdirSync(boundaryDir(), { recursive: true });
    fs.mkdirSync(decisionsDir(), { recursive: true });
    const decision = decisionFileFor('11111111-aaaa-bbbb-cccc-00000000000b');
    const request = path.join(boundaryDir(), '11111111-aaaa-bbbb-cccc-00000000000c.request.json');
    fs.writeFileSync(decision, '{"decision":"deny"}');
    fs.writeFileSync(request, '{}');
    // Young files survive a sweep at the true clock…
    sweepAgedBoundaryFiles(boundaryDir(), Date.now());
    sweepAgedBoundaryFiles(decisionsDir(), Date.now());
    expect(fs.existsSync(decision)).toBe(true);
    expect(fs.existsSync(request)).toBe(true);
    // …and age out past the ceiling.
    const future = Date.now() + BOUNDARY_FILE_MAX_AGE_MS + 60_000;
    sweepAgedBoundaryFiles(boundaryDir(), future);
    sweepAgedBoundaryFiles(decisionsDir(), future);
    expect(fs.existsSync(decision)).toBe(false);
    expect(fs.existsSync(request)).toBe(false);
  });

  it('the expiry timer denies and edits the card', async () => {
    vi.useFakeTimers();
    try {
      const adapter = makeAdapter();
      startCodeBoundaryWatcher(adapter);
      // Old enough that the timer lands at its 1s floor, young enough to route.
      const nearlyOver = new Date(Date.now() - HOST_EXPIRY_MS + 5_000).toISOString();
      seedRequest('11111111-aaaa-bbbb-cccc-000000000007', nearlyOver);
      await scanCodeBoundaryRequests();
      expect(adapter.deliver).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(6_000);
      expect(readDecision('11111111-aaaa-bbbb-cccc-000000000007')?.decision).toBe('deny');
      expect(await getPendingApprovalsByAction(CODE_BOUNDARY_ACTION)).toEqual([]);
      // The card was edited to its terminal state.
      const edit = JSON.parse(adapter.deliver.mock.calls[1][4] as string);
      expect(edit.operation).toBe('edit');
      expect(edit.terminalCard.resolution).toContain('Timed out');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('restart sweep', () => {
  it('denies orphaned rows from a previous process and edits their cards', async () => {
    fs.mkdirSync(decisionsDir(), { recursive: true }); // host-prepared at spawn
    const decisionFile = decisionFileFor('11111111-aaaa-bbbb-cccc-000000000008');
    await createPendingApproval({
      approval_id: 'cb-orphan1',
      session_id: SID,
      request_id: '11111111-aaaa-bbbb-cccc-000000000008',
      action: CODE_BOUNDARY_ACTION,
      payload: JSON.stringify({ decisionFile }),
      created_at: now(),
      agent_group_id: GID,
      channel_type: 'slack',
      platform_id: 'D-admin',
      platform_message_id: 'msg-old',
      title: 'Sandbox Boundary',
      question: 'q',
      options_json: '[]',
    });

    const adapter = makeAdapter();
    startCodeBoundaryWatcher(adapter);
    await vi.waitFor(async () => {
      expect(await getPendingApprovalsByAction(CODE_BOUNDARY_ACTION)).toEqual([]);
    });
    expect(JSON.parse(fs.readFileSync(decisionFile, 'utf8')).decision).toBe('deny');
    const edit = JSON.parse(adapter.deliver.mock.calls[0][4] as string);
    expect(edit.operation).toBe('edit');
    expect(edit.terminalCard.resolution).toContain('host restarted');
  });
});
