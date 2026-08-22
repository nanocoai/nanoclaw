/**
 * Synthetic tests for Lease Manager's scoped filesystem module. Every test
 * operates against a temp directory tree standing in for the Lease Manager
 * root -- LEASE_MANAGER_ROOT_WSL is mocked to point there, so no test ever
 * touches the real Lease Manager folder, its workbook, or any real lease.
 *
 * Ported from old commit 59de60dc, adapted from the pre-async central DB
 * (`getDb().prepare(sql).get/run(...)`, sync createAgentGroup/getSession/
 * guard/etc.) to the current async DbDriver and async db/*.ts,
 * guard(), and validate*() functions (see move.ts/copy.ts/mkdir.ts/
 * stage.ts/write-ops.ts) -- no behavior change.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, getSession } from '../../db/sessions.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { guard } from '../../guard/index.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { writeSessionMessage, sessionDir } from '../../session-manager.js';
import { requestApproval } from '../approvals/index.js';
import type { Session } from '../../types.js';

const TEST_ROOT = '/tmp/nanoclaw-test-lease-manager-fs-root';
const TEST_DATA_DIR = '/tmp/nanoclaw-test-lease-manager-fs-data';

const LEASE_MANAGER_AGENT_GROUP_ID = 'ag-8384e334-f3d2-4430-b77e-67b359f09beb';
const PEPPER_AGENT_GROUP_ID = 'ag-1786232390136-p4dww3';
const OTHER_AGENT_GROUP_ID = 'ag-some-other-agent';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

vi.mock('../approvals/index.js', async () => {
  const actual = await vi.importActual<typeof import('../approvals/index.js')>('../approvals/index.js');
  return { ...actual, requestApproval: vi.fn(actual.requestApproval) };
});

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-lease-manager-fs-data' };
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, LEASE_MANAGER_ROOT_WSL: '/tmp/nanoclaw-test-lease-manager-fs-root' };
});

import { resolveExistingPathWithinRoot, resolveNewPathWithinRoot } from './path-safety.js';
import { leaseFsMove, leaseFsCopy, leaseFsMkdir, leaseSignedLeaseStage } from './guard.js';
import { validateLeaseFsMove, requestLeaseFsMoveHold, applyLeaseFsMove } from './move.js';
import { validateLeaseFsCopy, requestLeaseFsCopyHold, applyLeaseFsCopy } from './copy.js';
import { validateLeaseFsMkdir, requestLeaseFsMkdirHold, applyLeaseFsMkdir } from './mkdir.js';
import { validateStageSignedLeaseUpload, applyStageSignedLeaseUpload } from './stage.js';
// Side-effect import: registerMigration() must run before runMigrations()
// below sees the lease_fs_operations/signed_lease_intake tables (see
// lowes-materials's tests for the same note).
import './index.js';

function now(): string {
  return new Date().toISOString();
}

function lastNotifiedText(): string | undefined {
  const call = vi.mocked(writeSessionMessage).mock.calls.at(-1);
  if (!call) return undefined;
  return (JSON.parse(call[2].content) as { text: string }).text;
}

function rebuildTestRoot(): void {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'Leases', 'Incoming'), { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'Leases', 'Current'), { recursive: true });
  fs.writeFileSync(path.join(TEST_ROOT, 'Leases', 'Incoming', 'sample.pdf'), 'SYNTHETIC PDF CONTENT');
}

let leaseManagerSession: Session;
let pepperSession: Session;

beforeEach(async () => {
  vi.clearAllMocks();
  rebuildTestRoot();
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  const db = await initTestDb();
  await runMigrations(db);

  await createAgentGroup({
    id: LEASE_MANAGER_AGENT_GROUP_ID,
    name: 'Lease Manager',
    folder: 'lease-manager',
    agent_provider: null,
    created_at: now(),
  });
  await createAgentGroup({
    id: PEPPER_AGENT_GROUP_ID,
    name: 'Pepper',
    folder: 'dm-with-kirk-durham',
    agent_provider: null,
    created_at: now(),
  });
  await createAgentGroup({
    id: OTHER_AGENT_GROUP_ID,
    name: 'Some Other Agent',
    folder: 'some-other-agent',
    agent_provider: null,
    created_at: now(),
  });

  await createMessagingGroup({
    id: 'mg-lm',
    channel_type: 'agent',
    platform_id: 'agent:lease-manager',
    name: 'Lease Manager internal',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-pepper',
    channel_type: 'telegram',
    platform_id: 'telegram:8855929473',
    name: 'Kirk DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });

  await createSession({
    id: 'sess-lm',
    agent_group_id: LEASE_MANAGER_AGENT_GROUP_ID,
    messaging_group_id: 'mg-lm',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });
  leaseManagerSession = (await getSession('sess-lm'))!;

  await createSession({
    id: 'sess-pepper',
    agent_group_id: PEPPER_AGENT_GROUP_ID,
    messaging_group_id: 'mg-pepper',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });
  pepperSession = (await getSession('sess-pepper'))!;

  // A real session's inbox root exists once anything has ever landed there.
  // Pre-create it so "no attachment landed yet" tests exercise the specific
  // file-not-found path rather than the "no inbox at all" path.
  fs.mkdirSync(path.join(sessionDir(pepperSession.agent_group_id, pepperSession.id), 'inbox'), { recursive: true });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('guards', () => {
  it("leaseFsMove/Copy/Mkdir hold unconditionally from the container path (agent-group check is the precheck's job, matching lease-manager-write)", async () => {
    for (const g of [leaseFsMove, leaseFsCopy, leaseFsMkdir]) {
      expect(
        (await guard(g, { actor: { kind: 'agent', agentGroupId: LEASE_MANAGER_AGENT_GROUP_ID }, payload: {}, grant: null }))
          .effect,
      ).toBe('hold');
      // Any agent-kind actor holds at the guard level -- OTHER_AGENT_GROUP_ID is rejected
      // by validateLeaseFsMove's precheck instead (see the "rejects a non-Lease-Manager caller" test).
      expect(
        (await guard(g, { actor: { kind: 'agent', agentGroupId: OTHER_AGENT_GROUP_ID }, payload: {}, grant: null })).effect,
      ).toBe('hold');
    }
  });

  it('leaseSignedLeaseStage allows only Pepper, never holds', async () => {
    expect(
      (
        await guard(leaseSignedLeaseStage, {
          actor: { kind: 'agent', agentGroupId: PEPPER_AGENT_GROUP_ID },
          payload: {},
          grant: null,
        })
      ).effect,
    ).toBe('allow');
    expect(
      (
        await guard(leaseSignedLeaseStage, {
          actor: { kind: 'agent', agentGroupId: LEASE_MANAGER_AGENT_GROUP_ID },
          payload: {},
          grant: null,
        })
      ).effect,
    ).toBe('deny');
  });
});

describe('path-safety', () => {
  it('accepts a valid existing file within root', () => {
    const result = resolveExistingPathWithinRoot(TEST_ROOT, 'Leases/Incoming/sample.pdf');
    expect(result.ok).toBe(true);
    expect(result.absolutePath).toBe(fs.realpathSync(path.join(TEST_ROOT, 'Leases', 'Incoming', 'sample.pdf')));
  });

  it('rejects ".." traversal', () => {
    const result = resolveExistingPathWithinRoot(TEST_ROOT, '../outside.pdf');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/\.\./);
  });

  it('rejects ".." buried inside a longer path', () => {
    const result = resolveExistingPathWithinRoot(TEST_ROOT, 'Leases/../../outside.pdf');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/\.\./);
  });

  it('rejects absolute unix paths', () => {
    const result = resolveExistingPathWithinRoot(TEST_ROOT, '/etc/passwd');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/absolute/);
  });

  it('rejects absolute Windows-style paths', () => {
    const result = resolveExistingPathWithinRoot(TEST_ROOT, 'C:\\Windows\\System32\\evil.pdf');
    expect(result.ok).toBe(false);
  });

  it('rejects a symlink inside root that escapes to outside root', () => {
    const outsideDir = fs.mkdtempSync('/tmp/nanoclaw-test-outside-');
    const outsideFile = path.join(outsideDir, 'secret.pdf');
    fs.writeFileSync(outsideFile, 'OUTSIDE ROOT');
    const linkPath = path.join(TEST_ROOT, 'escape-link');
    fs.symlinkSync(outsideFile, linkPath);

    const result = resolveExistingPathWithinRoot(TEST_ROOT, 'escape-link');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/outside/);

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('rejects a symlinked directory escape for a new-path destination', () => {
    const outsideDir = fs.mkdtempSync('/tmp/nanoclaw-test-outside-dir-');
    const linkDir = path.join(TEST_ROOT, 'escape-dir');
    fs.symlinkSync(outsideDir, linkDir);

    const result = resolveNewPathWithinRoot(TEST_ROOT, 'escape-dir/new-file.pdf');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/outside/);

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('rejects a destination that already exists -- no silent overwrite', () => {
    const result = resolveNewPathWithinRoot(TEST_ROOT, 'Leases/Incoming/sample.pdf');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already exists/);
  });

  it('rejects a nonexistent source', () => {
    const result = resolveExistingPathWithinRoot(TEST_ROOT, 'Leases/Incoming/does-not-exist.pdf');
    expect(result.ok).toBe(false);
  });

  it('rejects a destination whose parent does not exist', () => {
    const result = resolveNewPathWithinRoot(TEST_ROOT, 'Leases/NoSuchFolder/file.pdf');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/parent folder does not exist/);
  });
});

describe('lease_fs_move', () => {
  it('valid move succeeds after approval, and the audit row reflects it', async () => {
    const content = {
      source_relative_path: 'Leases/Incoming/sample.pdf',
      dest_relative_path: 'Leases/Current/1407 East Commerce Ave Apt C Signed Lease.pdf',
    };
    expect(await validateLeaseFsMove(content, leaseManagerSession)).toBe(true);
    await requestLeaseFsMoveHold(content, leaseManagerSession);

    const row = (await getDb().get<{ id: string; status: string; dest_relative_path: string }>(
      `SELECT * FROM lease_fs_operations WHERE operation_type='move'`,
    ))!;
    expect(row.status).toBe('pending');
    const requestId = row.id;

    // Simulate the approved replay (what reenterGuardedDeliveryAction triggers on Approve).
    await applyLeaseFsMove({ requestId, ...content }, leaseManagerSession);

    expect(
      fs.existsSync(path.join(TEST_ROOT, 'Leases', 'Current', '1407 East Commerce Ave Apt C Signed Lease.pdf')),
    ).toBe(true);
    expect(fs.existsSync(path.join(TEST_ROOT, 'Leases', 'Incoming', 'sample.pdf'))).toBe(false); // source removed on move

    const after = (await getDb().get<{ status: string }>(`SELECT status FROM lease_fs_operations WHERE id = ?`, requestId))!;
    expect(after.status).toBe('applied');
  });

  it('valid rename succeeds after approval (rename = move within the same folder)', async () => {
    const content = {
      source_relative_path: 'Leases/Incoming/sample.pdf',
      dest_relative_path: 'Leases/Incoming/renamed.pdf',
    };
    await requestLeaseFsMoveHold(content, leaseManagerSession);
    const row = (await getDb().get<{ id: string }>(`SELECT id FROM lease_fs_operations WHERE operation_type='move'`))!;
    await applyLeaseFsMove({ requestId: row.id, ...content }, leaseManagerSession);

    expect(fs.existsSync(path.join(TEST_ROOT, 'Leases', 'Incoming', 'renamed.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_ROOT, 'Leases', 'Incoming', 'sample.pdf'))).toBe(false);
  });

  it('the approval card shows the exact plain-language format requested', async () => {
    const content = {
      source_relative_path: 'Leases/Incoming/sample.pdf',
      dest_relative_path: 'Leases/Current/1407 East Commerce Ave Apt C Signed Lease.pdf',
      context_note: 'Signed lease for 1407 East Commerce Ave Apt C, uploaded via Pepper.',
    };
    await requestLeaseFsMoveHold(content, leaseManagerSession);
    const call = vi.mocked(requestApproval).mock.calls.at(-1)!;
    const question = call[0].question;
    expect(question).toContain(
      'Move Leases/Incoming/sample.pdf to Leases/Current/1407 East Commerce Ave Apt C Signed Lease.pdf',
    );
    expect(question).toContain('1407 East Commerce Ave Apt C');
  });

  it('destination collision fails closed at apply time and is recorded as failed', async () => {
    fs.writeFileSync(path.join(TEST_ROOT, 'Leases', 'Current', 'already-there.pdf'), 'EXISTING');
    const content = {
      source_relative_path: 'Leases/Incoming/sample.pdf',
      dest_relative_path: 'Leases/Current/already-there.pdf',
    };

    // Precheck should already reject this before any card is created.
    expect(await validateLeaseFsMove(content, leaseManagerSession)).toBe(false);
    expect(lastNotifiedText()).toMatch(/already exists/);

    // Existing content must be untouched.
    expect(fs.readFileSync(path.join(TEST_ROOT, 'Leases', 'Current', 'already-there.pdf'), 'utf8')).toBe('EXISTING');
  });

  it('rejects a non-Lease-Manager caller', async () => {
    const content = { source_relative_path: 'Leases/Incoming/sample.pdf', dest_relative_path: 'Leases/Current/x.pdf' };
    expect(await validateLeaseFsMove(content, pepperSession)).toBe(false);
    expect(lastNotifiedText()).toContain('not permitted');
  });
});

describe('lease_fs_copy', () => {
  it('valid copy succeeds after approval, leaving the source in place', async () => {
    const content = {
      source_relative_path: 'Leases/Incoming/sample.pdf',
      dest_relative_path: 'Leases/Current/copy-of-sample.pdf',
    };
    await requestLeaseFsCopyHold(content, leaseManagerSession);
    const row = (await getDb().get<{ id: string }>(`SELECT id FROM lease_fs_operations WHERE operation_type='copy'`))!;
    await applyLeaseFsCopy({ requestId: row.id, ...content }, leaseManagerSession);

    expect(fs.existsSync(path.join(TEST_ROOT, 'Leases', 'Current', 'copy-of-sample.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_ROOT, 'Leases', 'Incoming', 'sample.pdf'))).toBe(true); // source stays

    const after = (await getDb().get<{ status: string }>(`SELECT status FROM lease_fs_operations WHERE id = ?`, row.id))!;
    expect(after.status).toBe('applied');
  });
});

describe('lease_fs_mkdir', () => {
  it('succeeds after approval', async () => {
    const content = { relative_path: 'Leases/Archive' };
    expect(await validateLeaseFsMkdir(content, leaseManagerSession)).toBe(true);
    await requestLeaseFsMkdirHold(content, leaseManagerSession);
    const row = (await getDb().get<{ id: string }>(`SELECT id FROM lease_fs_operations WHERE operation_type='mkdir'`))!;
    await applyLeaseFsMkdir({ requestId: row.id, ...content }, leaseManagerSession);

    expect(fs.existsSync(path.join(TEST_ROOT, 'Leases', 'Archive'))).toBe(true);
    expect(fs.statSync(path.join(TEST_ROOT, 'Leases', 'Archive')).isDirectory()).toBe(true);

    const after = (await getDb().get<{ status: string }>(`SELECT status FROM lease_fs_operations WHERE id = ?`, row.id))!;
    expect(after.status).toBe('applied');
  });

  it('fails closed if the folder already exists', async () => {
    const content = { relative_path: 'Leases/Current' };
    expect(await validateLeaseFsMkdir(content, leaseManagerSession)).toBe(false);
    expect(lastNotifiedText()).toMatch(/already exists/);
  });
});

describe('containment guarantee -- no operation can write outside the root', () => {
  it('a move with a ".." destination never creates a file outside root, and fails closed', async () => {
    const content = { source_relative_path: 'Leases/Incoming/sample.pdf', dest_relative_path: '../escaped.pdf' };
    expect(await validateLeaseFsMove(content, leaseManagerSession)).toBe(false);
    expect(fs.existsSync(path.join(TEST_ROOT, '..', 'escaped.pdf'))).toBe(false);
  });

  it('apply-time re-check also rejects an escaping path even if it somehow reached apply()', async () => {
    // Simulates a payload that bypassed precheck (e.g. a guard/replay bug) --
    // apply() must independently re-verify and refuse to touch anything outside root.
    const requestId = 'forced-request-id';
    await getDb().run(
      `INSERT INTO lease_fs_operations (id, operation_type, source_relative_path, dest_relative_path, requested_by_agent_group_id, requested_at, status, created_at)
       VALUES (?, 'move', 'Leases/Incoming/sample.pdf', '../escaped.pdf', ?, ?, 'pending', ?)`,
      requestId,
      LEASE_MANAGER_AGENT_GROUP_ID,
      now(),
      now(),
    );

    await applyLeaseFsMove(
      { requestId, source_relative_path: 'Leases/Incoming/sample.pdf', dest_relative_path: '../escaped.pdf' },
      leaseManagerSession,
    );

    expect(fs.existsSync(path.join(TEST_ROOT, '..', 'escaped.pdf'))).toBe(false);
    const after = (await getDb().get<{ status: string; error: string }>(
      `SELECT status, error FROM lease_fs_operations WHERE id = ?`,
      requestId,
    ))!;
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/\.\./);
  });
});

describe('audit trail', () => {
  it('writes a pending row at request time, before any approval', async () => {
    const content = {
      source_relative_path: 'Leases/Incoming/sample.pdf',
      dest_relative_path: 'Leases/Current/audited.pdf',
    };
    await requestLeaseFsMoveHold(content, leaseManagerSession);
    const row = (await getDb().get<{ status: string; source_relative_path: string; requested_by_agent_group_id: string }>(
      `SELECT * FROM lease_fs_operations WHERE dest_relative_path = ?`,
      'Leases/Current/audited.pdf',
    ))!;
    expect(row.status).toBe('pending');
    expect(row.source_relative_path).toBe('Leases/Incoming/sample.pdf');
    expect(row.requested_by_agent_group_id).toBe(LEASE_MANAGER_AGENT_GROUP_ID);
  });

  it('writes a failed row for a rejected-at-apply-time operation (destination collision)', async () => {
    const requestId = 'collision-request-id';
    fs.writeFileSync(path.join(TEST_ROOT, 'Leases', 'Current', 'taken.pdf'), 'X');
    await getDb().run(
      `INSERT INTO lease_fs_operations (id, operation_type, source_relative_path, dest_relative_path, requested_by_agent_group_id, requested_at, status, created_at)
       VALUES (?, 'move', 'Leases/Incoming/sample.pdf', 'Leases/Current/taken.pdf', ?, ?, 'pending', ?)`,
      requestId,
      LEASE_MANAGER_AGENT_GROUP_ID,
      now(),
      now(),
    );

    await applyLeaseFsMove(
      { requestId, source_relative_path: 'Leases/Incoming/sample.pdf', dest_relative_path: 'Leases/Current/taken.pdf' },
      leaseManagerSession,
    );

    const after = (await getDb().get<{ status: string; error: string }>(
      `SELECT status, error FROM lease_fs_operations WHERE id = ?`,
      requestId,
    ))!;
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/already exists/);
  });

  it('a successful operation is recorded applied, with no error', async () => {
    const content = {
      source_relative_path: 'Leases/Incoming/sample.pdf',
      dest_relative_path: 'Leases/Current/clean.pdf',
    };
    await requestLeaseFsMoveHold(content, leaseManagerSession);
    const row = (await getDb().get<{ id: string }>(
      `SELECT id FROM lease_fs_operations WHERE dest_relative_path = 'Leases/Current/clean.pdf'`,
    ))!;
    await applyLeaseFsMove({ requestId: row.id, ...content }, leaseManagerSession);

    const after = (await getDb().get<{ status: string; error: string | null }>(
      `SELECT status, error FROM lease_fs_operations WHERE id = ?`,
      row.id,
    ))!;
    expect(after.status).toBe('applied');
    expect(after.error).toBeNull();
  });
});

describe('stage_signed_lease_upload', () => {
  it('rejects a non-Pepper caller', async () => {
    expect(
      await validateStageSignedLeaseUpload({ attachment_path: '/workspace/inbox/m1/lease.pdf' }, leaseManagerSession),
    ).toBe(false);
  });

  it('durably copies a manually-placed inbox file into Leases/Incoming and records an intake row', async () => {
    const { sessionDir } = await import('../../session-manager.js');
    const inboxDir = path.join(sessionDir(pepperSession.agent_group_id, pepperSession.id), 'inbox', 'msg-1');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'NC Lease Agreement v2.pdf'), 'SIGNED SYNTHETIC LEASE');

    const content = { attachment_path: '/workspace/inbox/msg-1/NC Lease Agreement v2.pdf', note: 'for 1407C' };
    expect(await validateStageSignedLeaseUpload(content, pepperSession)).toBe(true);
    await applyStageSignedLeaseUpload(content, pepperSession);

    const intake = (await getDb().get<{
      id: string;
      staged_path: string;
      status: string;
      note: string;
      uploaded_via_message_id: string;
    }>(`SELECT * FROM signed_lease_intake WHERE original_filename = ?`, 'NC Lease Agreement v2.pdf'))!;
    expect(intake.status).toBe('staged');
    expect(intake.note).toBe('for 1407C');
    expect(intake.uploaded_via_message_id).toBe('msg-1');
    expect(fs.existsSync(intake.staged_path)).toBe(true);
    expect(intake.staged_path.startsWith(path.join(TEST_ROOT, 'Leases', 'Incoming'))).toBe(true);
    expect(fs.readFileSync(intake.staged_path, 'utf8')).toBe('SIGNED SYNTHETIC LEASE');
  });

  it('accepts the bare "inbox/..." form too (no /workspace/ prefix)', async () => {
    const { sessionDir } = await import('../../session-manager.js');
    const inboxDir = path.join(sessionDir(pepperSession.agent_group_id, pepperSession.id), 'inbox', 'msg-2');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'lease.pdf'), 'X');

    const content = { attachment_path: 'inbox/msg-2/lease.pdf' };
    expect(await validateStageSignedLeaseUpload(content, pepperSession)).toBe(true);
  });

  it('rejects a non-PDF attachment with a specific reason', async () => {
    const { sessionDir } = await import('../../session-manager.js');
    const inboxDir = path.join(sessionDir(pepperSession.agent_group_id, pepperSession.id), 'inbox', 'msg-3');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'notes.docx'), 'not a pdf');

    const content = { attachment_path: '/workspace/inbox/msg-3/notes.docx' };
    expect(await validateStageSignedLeaseUpload(content, pepperSession)).toBe(false);
    expect(lastNotifiedText()).toMatch(/only PDF attachments/);
  });

  it('rejects a malformed attachment_path with a specific, actionable diagnostic (not a silent dead end)', async () => {
    for (const bad of [
      'not-a-real-path',
      '/etc/passwd',
      'inbox/only-one-segment',
      'inbox/a/b/c/too-many-segments.pdf',
    ]) {
      expect(await validateStageSignedLeaseUpload({ attachment_path: bad }, pepperSession)).toBe(false);
      expect(lastNotifiedText()).toContain('attachment_path must be the exact path shown');
    }
  });

  it('rejects a path that does not resolve to an existing file, with the resolved location named', async () => {
    const content = { attachment_path: '/workspace/inbox/nonexistent-msg/nonexistent.pdf' };
    expect(await validateStageSignedLeaseUpload(content, pepperSession)).toBe(false);
    expect(lastNotifiedText()).toMatch(/no file exists at the resolved path/);
  });

  it('rejects an attempt to escape the session inbox via a symlink', async () => {
    const { sessionDir } = await import('../../session-manager.js');
    const inboxDir = path.join(sessionDir(pepperSession.agent_group_id, pepperSession.id), 'inbox', 'msg-escape');
    fs.mkdirSync(inboxDir, { recursive: true });
    const outsideDir = fs.mkdtempSync('/tmp/nanoclaw-test-stage-outside-');
    fs.writeFileSync(path.join(outsideDir, 'secret.pdf'), 'OUTSIDE');
    fs.symlinkSync(path.join(outsideDir, 'secret.pdf'), path.join(inboxDir, 'lease.pdf'));

    const content = { attachment_path: '/workspace/inbox/msg-escape/lease.pdf' };
    expect(await validateStageSignedLeaseUpload(content, pepperSession)).toBe(false);
    expect(lastNotifiedText()).toMatch(/escapes this session's own inbox/);

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  describe('real boundary: an actual inbound message with an attachment, through the real landing pipeline', () => {
    it("a real attachment landed via writeSessionMessage produces a path that stage_signed_lease_upload accepts -- reproducing the reported bug's fix", async () => {
      // Bypass the local writeSessionMessage mock (used elsewhere to spy on
      // notifyAgent's outbound writes) and call the REAL implementation, so
      // this exercises the actual inbound-attachment pipeline a real
      // Telegram message goes through: session-manager.ts's
      // extractAttachmentFiles, which writes the file to
      // inbox/<message.id>/<filename> and rewrites the attachment's
      // localPath to that same relative path.
      const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');

      const realMessageId = `real-msg-${randomBytes(8).toString('hex')}`;
      const pdfBytes = Buffer.from('%PDF-1.4 SYNTHETIC REAL SIGNED LEASE BYTES');
      await actual.writeSessionMessage(pepperSession.agent_group_id, pepperSession.id, {
        id: realMessageId,
        kind: 'chat',
        timestamp: now(),
        platformId: 'telegram:8855929473',
        channelType: 'telegram',
        content: JSON.stringify({
          text: 'here is the signed lease for 1407C',
          attachments: [{ name: 'NC Lease Agreement v2.pdf', type: 'document', data: pdfBytes.toString('base64') }],
        }),
      });

      // Read back what the host actually stored -- not what we assume it stored.
      // inbound.db is a raw per-session sqlite file, not the central DB --
      // unaffected by the async DbDriver migration, read here exactly as
      // before. inboundDbPath moved to mailbox/sqlite/paths.js upstream
      // (was re-exported from session-manager.js in the old commit).
      const inboundDb = new Database(inboundDbPath(pepperSession.agent_group_id, pepperSession.id), {
        readonly: true,
      });
      const row = inboundDb.prepare('SELECT id, seq, content FROM messages_in WHERE id = ?').get(realMessageId) as {
        id: string;
        seq: number;
        content: string;
      };
      inboundDb.close();
      const storedContent = JSON.parse(row.content) as { attachments: Array<{ name: string; localPath: string }> };
      const localPath = storedContent.attachments[0].localPath;
      expect(localPath).toBe(`inbox/${realMessageId}/NC Lease Agreement v2.pdf`);

      // This mirrors formatAttachments() in container/agent-runner/src/formatter.ts
      // EXACTLY (`[${type}: ${name} — saved to /workspace/${localPath}]`) --
      // i.e. the literal text a real agent sees in its own conversation.
      const shownToAgent = `[document: NC Lease Agreement v2.pdf — saved to /workspace/${localPath}]`;
      // .+ (not \S+): a real filename can contain spaces ("NC Lease Agreement v2.pdf" does).
      const pathAgentWouldCopy = shownToAgent.match(/saved to (.+)\]$/)![1];
      expect(pathAgentWouldCopy).toBe(`/workspace/inbox/${realMessageId}/NC Lease Agreement v2.pdf`);

      // The actual fix: feeding exactly that copied string succeeds.
      const content = { attachment_path: pathAgentWouldCopy, note: 'for 1407C' };
      expect(await validateStageSignedLeaseUpload(content, pepperSession)).toBe(true);
      await applyStageSignedLeaseUpload(content, pepperSession);

      const intake = (await getDb().get<{ staged_path: string; status: string }>(
        `SELECT * FROM signed_lease_intake WHERE uploaded_via_message_id = ?`,
        realMessageId,
      ))!;
      expect(intake.status).toBe('staged');
      expect(fs.readFileSync(intake.staged_path)).toEqual(pdfBytes);

      // And prove the two wrong identifiers Kirk actually tried both fail
      // closed with a specific, useful reason -- not a silent dead end.
      const seqGuess = { attachment_path: `/workspace/inbox/${row.seq}/NC Lease Agreement v2.pdf` };
      expect(await validateStageSignedLeaseUpload(seqGuess, pepperSession)).toBe(false);
      expect(lastNotifiedText()).toMatch(/no file exists at the resolved path/);

      const platformIdGuess = { attachment_path: '/workspace/inbox/telegram:8855929473/NC Lease Agreement v2.pdf' };
      expect(await validateStageSignedLeaseUpload(platformIdGuess, pepperSession)).toBe(false);
      expect(lastNotifiedText()).toMatch(/no file exists at the resolved path/);
    });
  });
});
