/**
 * Synthetic tests for controlled Lease Manager document delivery. Every test
 * operates against a temp directory standing in for the Drafts folder --
 * DRAFTS_DIR_WSL is mocked to point there, so no test ever touches the real
 * Lease Manager folder or a real lease PDF. Actual Telegram delivery is
 * replaced with an in-memory fake adapter via setDeliveryAdapter (the same
 * seam production wiring uses) -- nothing here reaches a real chat.
 *
 * Ported from old commit 59de60dc, adapted from the pre-async central DB
 * and sync createAgentGroup/getSession/guard/registerGeneratedDocument/
 * resolveAndValidateDocument/validateLeaseDocumentDeliver to their current
 * async equivalents -- no behavior change.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, getSession } from '../../db/sessions.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { guard } from '../../guard/index.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

const TEST_DRAFTS_DIR = '/tmp/nanoclaw-test-lease-document-delivery-drafts';

const LEASE_MANAGER_AGENT_GROUP_ID = 'ag-8384e334-f3d2-4430-b77e-67b359f09beb';
const PEPPER_AGENT_GROUP_ID = 'ag-1786232390136-p4dww3';
const OTHER_AGENT_GROUP_ID = 'ag-some-other-agent';
const KIRK_PLATFORM_ID = 'telegram:8855929473';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DRAFTS_DIR_WSL: '/tmp/nanoclaw-test-lease-document-delivery-drafts' };
});

// Side-effect import: registerMigration() must run before runMigrations()
// below sees the lease_generated_documents/lease_document_deliveries
// tables (see lowes-materials's tests for the same note).
import './index.js';
import { registerGeneratedDocument } from './registry.js';
import { resolveAndValidateDocument } from './resolve.js';
import { leaseDocumentDeliver } from './guard.js';
import { validateLeaseDocumentDeliver, requestLeaseDocumentDeliverHold } from './request.js';
import { applyLeaseDocumentDeliver } from './apply.js';

function now(): string {
  return new Date().toISOString();
}

function lastNotifiedText(): string | undefined {
  const call = vi.mocked(writeSessionMessage).mock.calls.at(-1);
  if (!call) return undefined;
  return (JSON.parse(call[2].content) as { text: string }).text;
}

function rebuildDraftsDir(): void {
  if (fs.existsSync(TEST_DRAFTS_DIR)) fs.rmSync(TEST_DRAFTS_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DRAFTS_DIR, { recursive: true });
}

/** In-memory fake delivery adapter -- records calls, never touches a real channel. */
function makeFakeAdapter(opts?: { throwOn?: boolean }): ChannelDeliveryAdapter & {
  calls: Array<Parameters<ChannelDeliveryAdapter['deliver']>>;
} {
  const calls: Array<Parameters<ChannelDeliveryAdapter['deliver']>> = [];
  return {
    calls,
    async deliver(...args) {
      calls.push(args);
      if (opts?.throwOn) throw new Error('synthetic delivery failure');
      return 'fake-platform-message-id';
    },
  };
}

let pepperSession: Session;
let otherAgentSession: Session;

beforeEach(async () => {
  vi.clearAllMocks();
  rebuildDraftsDir();

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
    id: 'mg-kirk',
    channel_type: 'telegram',
    platform_id: KIRK_PLATFORM_ID,
    name: 'Kirk DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-wrong',
    channel_type: 'telegram',
    platform_id: 'telegram:999999999',
    name: 'Some other chat',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });

  await createSession({
    id: 'sess-pepper',
    agent_group_id: PEPPER_AGENT_GROUP_ID,
    messaging_group_id: 'mg-kirk',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });
  pepperSession = (await getSession('sess-pepper'))!;

  await createSession({
    id: 'sess-other',
    agent_group_id: OTHER_AGENT_GROUP_ID,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });
  otherAgentSession = (await getSession('sess-other'))!;
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DRAFTS_DIR)) fs.rmSync(TEST_DRAFTS_DIR, { recursive: true, force: true });
});

async function registerFixtureDocument(filename = 'draft.pdf'): Promise<{ id: string; filePath: string }> {
  const filePath = path.join(TEST_DRAFTS_DIR, filename);
  fs.writeFileSync(filePath, 'SYNTHETIC PDF CONTENT');
  const id = await registerGeneratedDocument({
    generationRequestId: 'lmg-fixture-1',
    filePath,
    propertyAddress: 'SYNTHETIC 123 Fixture St',
  });
  return { id, filePath };
}

describe('resolveAndValidateDocument', () => {
  it('rejects a missing/unknown reference without confirming or denying its shape', async () => {
    const result = await resolveAndValidateDocument('not-a-real-id');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Unknown document reference');
  });

  it('rejects a non-string reference', async () => {
    const result = await resolveAndValidateDocument(undefined);
    expect(result.ok).toBe(false);
  });

  it('resolves a registered, on-disk PDF inside the configured Drafts directory', async () => {
    const { id, filePath } = await registerFixtureDocument();
    const result = await resolveAndValidateDocument(id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.filePath).toBe(fs.realpathSync(filePath));
      expect(result.document.propertyAddress).toBe('SYNTHETIC 123 Fixture St');
    }
  });

  it('rejects a registered row whose file is not a .pdf', async () => {
    const filePath = path.join(TEST_DRAFTS_DIR, 'not-a-lease.txt');
    fs.writeFileSync(filePath, 'not a pdf');
    const id = await registerGeneratedDocument({ generationRequestId: 'lmg-x', filePath, propertyAddress: 'x' });
    const result = await resolveAndValidateDocument(id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not a PDF');
  });

  it('rejects a registered path that resolves outside the configured Drafts directory', async () => {
    const outsideDir = '/tmp/nanoclaw-test-lease-document-delivery-outside';
    fs.mkdirSync(outsideDir, { recursive: true });
    const filePath = path.join(outsideDir, 'escaped.pdf');
    fs.writeFileSync(filePath, 'x');
    const id = await registerGeneratedDocument({ generationRequestId: 'lmg-y', filePath, propertyAddress: 'x' });
    const result = await resolveAndValidateDocument(id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Drafts directory');
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('rejects a registered row whose file no longer exists on disk', async () => {
    const filePath = path.join(TEST_DRAFTS_DIR, 'gone.pdf');
    fs.writeFileSync(filePath, 'x');
    const id = await registerGeneratedDocument({ generationRequestId: 'lmg-z', filePath, propertyAddress: 'x' });
    fs.rmSync(filePath);
    const result = await resolveAndValidateDocument(id);
    expect(result.ok).toBe(false);
    // realpathSync throws first (ENOENT) since the file is gone -- this
    // never reaches the later "not a regular file" stat branch.
    if (!result.ok) expect(result.reason).toContain('Could not resolve the document on disk');
  });
});

describe('guard: leaseDocumentDeliver', () => {
  it('allows only Pepper, never holds', async () => {
    expect(
      (
        await guard(leaseDocumentDeliver, {
          actor: { kind: 'agent', agentGroupId: PEPPER_AGENT_GROUP_ID },
          payload: {},
          grant: null,
        })
      ).effect,
    ).toBe('allow');
  });

  it('denies every other agent group', async () => {
    expect(
      (
        await guard(leaseDocumentDeliver, {
          actor: { kind: 'agent', agentGroupId: LEASE_MANAGER_AGENT_GROUP_ID },
          payload: {},
          grant: null,
        })
      ).effect,
    ).toBe('deny');
    expect(
      (
        await guard(leaseDocumentDeliver, {
          actor: { kind: 'agent', agentGroupId: OTHER_AGENT_GROUP_ID },
          payload: {},
          grant: null,
        })
      ).effect,
    ).toBe('deny');
  });
});

describe('validateLeaseDocumentDeliver', () => {
  it('rejects a non-Pepper caller', async () => {
    const { id } = await registerFixtureDocument();
    expect(await validateLeaseDocumentDeliver({ document_reference: id }, otherAgentSession)).toBe(false);
    expect(lastNotifiedText()).toContain('not permitted for this agent');
  });

  it('rejects an unresolvable reference even for Pepper', async () => {
    expect(await validateLeaseDocumentDeliver({ document_reference: 'bogus' }, pepperSession)).toBe(false);
  });

  it('passes for Pepper with a real registered document', async () => {
    const { id } = await registerFixtureDocument();
    expect(await validateLeaseDocumentDeliver({ document_reference: id }, pepperSession)).toBe(true);
  });
});

describe('requestLeaseDocumentDeliverHold (should never actually be invoked)', () => {
  it('fails loudly rather than silently creating a card', async () => {
    await requestLeaseDocumentDeliverHold({}, pepperSession);
    expect(lastNotifiedText()).toContain('unexpected approval hold');
  });
});

describe('applyLeaseDocumentDeliver', () => {
  it('delivers the file through the fake adapter and records a success row', async () => {
    const adapter = makeFakeAdapter();
    setDeliveryAdapter(adapter);
    const { id, filePath } = await registerFixtureDocument('123-main-st.pdf');

    await applyLeaseDocumentDeliver({ document_reference: id }, pepperSession);

    expect(adapter.calls).toHaveLength(1);
    const [channelType, platformId, , kind, content, files] = adapter.calls[0];
    expect(channelType).toBe('telegram');
    expect(platformId).toBe(KIRK_PLATFORM_ID);
    expect(kind).toBe('chat');
    expect(JSON.parse(content).text).toContain('SYNTHETIC 123 Fixture St');
    expect(files).toHaveLength(1);
    expect(files![0].filename).toBe('123-main-st.pdf');
    expect(files![0].data.toString()).toBe(fs.readFileSync(filePath).toString());

    const rows = await getDb().all<{ status: string; error: string | null }>(
      'SELECT status, error FROM lease_document_deliveries WHERE document_id = ?',
      id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].error).toBeNull();
    expect(lastNotifiedText()).toContain('Document delivered');
  });

  it("never calls the adapter when the destination is not Kirk's trusted conversation", async () => {
    const adapter = makeFakeAdapter();
    setDeliveryAdapter(adapter);
    const { id } = await registerFixtureDocument();

    const wrongSession = { ...pepperSession, messaging_group_id: 'mg-wrong' };
    await applyLeaseDocumentDeliver({ document_reference: id }, wrongSession);

    expect(adapter.calls).toHaveLength(0);
    const rows = await getDb().all<{ status: string; error: string | null }>(
      'SELECT status, error FROM lease_document_deliveries WHERE document_id = ?',
      id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toContain('trusted Telegram conversation');
    expect(lastNotifiedText()).toContain('source file was not touched');
  });

  it('records a failed attempt without touching the source file when the adapter throws', async () => {
    const adapter = makeFakeAdapter({ throwOn: true });
    setDeliveryAdapter(adapter);
    const { id, filePath } = await registerFixtureDocument();
    const before = fs.readFileSync(filePath);

    await applyLeaseDocumentDeliver({ document_reference: id }, pepperSession);

    expect(fs.readFileSync(filePath)).toEqual(before);
    const rows = await getDb().all<{ status: string; error: string | null }>(
      'SELECT status, error FROM lease_document_deliveries WHERE document_id = ?',
      id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toContain('synthetic delivery failure');
  });

  it('records a failed attempt when no delivery adapter is set', async () => {
    // setDeliveryAdapter has module-level state; explicitly clear it for this
    // one test rather than relying on test execution order.
    const { setDeliveryAdapter: setAdapter } = await import('../../delivery.js');
    // @ts-expect-error -- resetting module state to "unset" for this test only
    setAdapter(null);

    const { id } = await registerFixtureDocument();
    await applyLeaseDocumentDeliver({ document_reference: id }, pepperSession);

    const rows = await getDb().all<{ status: string; error: string | null }>(
      'SELECT status, error FROM lease_document_deliveries WHERE document_id = ?',
      id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toContain('not currently available');
  });
});
