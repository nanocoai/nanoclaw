/**
 * A container killed mid-write strands a hot journal in outbound.db, and every
 * host read of the session then fails before the due-message count, so the
 * session was never woken (upstream #4056). The sweep must clear the residue
 * through the mailbox (no container spawned for it) and wake the session for
 * its due message on the same tick, but never while a container is
 * registered. Real central DB and real session DBs; only the runner is mocked.
 */
import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/nanoclaw-test-reconcile-journal-${process.pid}` }));

vi.mock('./config.js', async () => ({
  ...(await vi.importActual<typeof import('./config.js')>('./config.js')),
  DATA_DIR: TEST_DIR,
  ABSOLUTE_CEILING_MS_RAW: '',
  CLAIM_STUCK_MS_RAW: '',
}));

vi.mock('./container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  hasHostRuntime: vi.fn().mockReturnValue(false),
  isClaimedByLivePeer: vi.fn().mockResolvedValue(false),
  isContainerRunning: vi.fn().mockReturnValue(false),
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
}));

import { hasHostRuntime, isClaimedByLivePeer, isContainerRunning, wakeContainer } from './container-runner.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { createSession } from './db/sessions.js';
import { outboundDbPath } from './mailbox/sqlite/paths.js';
import { reconcileSession } from './reconcile-session.js';
import { initSessionFolder, writeSessionMessage } from './session-manager.js';
import { strandJournal } from './test-utils/strand-journal.js';

const AG = 'ag-journal';
const SESS = 'sess-journal';
const now = () => new Date().toISOString();
const journal = () => `${outboundDbPath(AG, SESS)}-journal`;

describe('sweep with a stranded outbound journal', () => {
  beforeEach(async () => {
    vi.mocked(isContainerRunning).mockReset().mockReturnValue(false);
    vi.mocked(hasHostRuntime).mockReset().mockReturnValue(false);
    vi.mocked(isClaimedByLivePeer).mockReset().mockResolvedValue(false);
    vi.mocked(wakeContainer).mockReset().mockResolvedValue(true);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = await initTestDb();
    await runMigrations(db);
    await createAgentGroup({ id: AG, name: 'Journal', folder: 'journal', agent_provider: null, created_at: now() });
    await createSession({
      id: SESS,
      agent_group_id: AG,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
    initSessionFolder(AG, SESS);
    await writeSessionMessage(AG, SESS, { id: 'm-1', kind: 'chat', timestamp: now(), content: '{"text":"hi"}' });
    strandJournal(outboundDbPath(AG, SESS));
  });

  afterEach(async () => {
    await closeDb();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('clears the residue and wakes the session for its due message on the same sweep', async () => {
    await reconcileSession(SESS);
    expect(fs.existsSync(journal())).toBe(false);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('leaves storage alone while this host holds the runtime (registered, spawning, adopting)', async () => {
    vi.mocked(isContainerRunning).mockReturnValue(true);
    vi.mocked(hasHostRuntime).mockReturnValue(true);
    await reconcileSession(SESS);
    expect(fs.existsSync(journal())).toBe(true);
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('leaves storage alone for a survivor awaiting adoption (not registered, still alive)', async () => {
    vi.mocked(hasHostRuntime).mockReturnValue(true);
    await reconcileSession(SESS);
    expect(fs.existsSync(journal())).toBe(true);
  });

  it('leaves storage alone while another live host process holds the claim', async () => {
    vi.mocked(isClaimedByLivePeer).mockResolvedValue(true);
    await reconcileSession(SESS);
    expect(fs.existsSync(journal())).toBe(true);
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('does not wake a session that has nothing due', async () => {
    const { getAgentMailbox } = await import('./mailbox/index.js');
    // consume the due message so only the residue remains
    await getAgentMailbox().session({ agentGroupId: AG, sessionId: SESS }, (mb) => mb.markMessageFailed('m-1'));
    await reconcileSession(SESS);
    expect(fs.existsSync(journal())).toBe(false);
    expect(wakeContainer).not.toHaveBeenCalled();
  });
});
