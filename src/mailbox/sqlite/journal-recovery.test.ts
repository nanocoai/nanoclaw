/**
 * A container killed mid-transaction leaves a hot outbound journal that the
 * host's read-only handle cannot roll back (upstream #4056). These tests make a
 * real hot journal by SIGKILLing a writer mid-transaction and pin the facts the
 * sweep relies on: host reads fail with SQLITE_READONLY_ROLLBACK, the mailbox
 * classifies that (and only that) as recoverable residue, and recoverResidue,
 * through the mailbox's own writable connection, clears it and rolls the killed
 * transaction back.
 */
import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = vi.hoisted(() => `/tmp/nanoclaw-journal-recovery-test-${process.pid}`);

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));

import { SqliteAgentMailbox } from './index.js';
import { sessionMailboxPath } from './paths.js';
import { strandJournal } from '../../test-utils/strand-journal.js';

const key = { agentGroupId: 'ag-test', sessionId: 'sess-test' };

describe('stranded outbound journal', () => {
  let mailbox: SqliteAgentMailbox;
  let outbound: string;

  beforeEach(() => {
    mailbox = new SqliteAgentMailbox();
    mailbox.prepare(key);
    outbound = sessionMailboxPath(key, 'outbound');
    strandJournal(outbound);
  });

  afterEach(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('fails host reads with SQLITE_READONLY_ROLLBACK, which the mailbox classifies as recoverable', async () => {
    const err = await mailbox.session(key, (mb) => mb.getDueMessages()).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('SQLITE_READONLY_ROLLBACK');
    expect(mailbox.isRecoverableResidue(err)).toBe(true);
  });

  it('recoverResidue clears it through the writable connection and rolls the killed transaction back', async () => {
    await mailbox.session(key, (mb) => mb.recoverResidue?.());
    expect(fs.existsSync(`${outbound}-journal`)).toBe(false);
    await expect(mailbox.session(key, (mb) => mb.getDueMessages())).resolves.toEqual([]);
  });

  it('classifies nothing else as recoverable', () => {
    expect(mailbox.isRecoverableResidue({ code: 'SQLITE_READONLY' })).toBe(false);
    expect(mailbox.isRecoverableResidue({ code: 'SQLITE_BUSY' })).toBe(false);
    expect(mailbox.isRecoverableResidue(new Error('attempt to write a readonly database'))).toBe(false);
    expect(mailbox.isRecoverableResidue(null)).toBe(false);
  });
});
