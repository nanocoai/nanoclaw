/**
 * Attach-presence stamp (D17): the file the code runner writes so hook
 * subprocesses can tell attached (a prompt is answerable in the PTY) from
 * detached (it needs the approvals path). Absence and damage both read as
 * detached — the escalating end — and writes are atomic.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach } from 'bun:test';

import {
  ATTACH_EVIDENCE_MS,
  ATTACH_STAMP_FRESH_MS,
  hasLiveAttachEvidence,
  readAttachState,
  readDoorActivityAt,
  readMailNotice,
  writeAttachState,
  writeMailNotice,
} from './agent-state.js';

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-attach-state-'));
  statePath = path.join(dir, 'attach-state.json');
});

describe('attach state', () => {
  it('round-trips the client count with a timestamp', () => {
    writeAttachState(2, statePath);
    const state = readAttachState(statePath)!;
    expect(state.clients).toBe(2);
    expect(Number.isFinite(Date.parse(state.at))).toBe(true);

    writeAttachState(0, statePath);
    expect(readAttachState(statePath)!.clients).toBe(0);
  });

  it('a missing or torn file reads as absent — the detached (escalating) end', () => {
    expect(readAttachState(statePath)).toBeNull();
    fs.writeFileSync(statePath, '{"clien'); // torn mid-write
    expect(readAttachState(statePath)).toBeNull();
    fs.writeFileSync(statePath, JSON.stringify({ clients: 'two', at: new Date().toISOString() }));
    expect(readAttachState(statePath)).toBeNull();
  });

  it('writes atomically: no tmp residue, the final rename is the only visible state', () => {
    writeAttachState(1, statePath);
    expect(fs.readdirSync(dir)).toEqual(['attach-state.json']);
  });

  it('carries the human evidence the boundary hook routes on', () => {
    writeAttachState(1, statePath, { lastInputAt: 111, lastConnectAt: 222 });
    const state = readAttachState(statePath)!;
    expect(state.lastInputAt).toBe(111);
    expect(state.lastConnectAt).toBe(222);
  });
});

describe('door activity', () => {
  it('reads the stamp mtime; a never-stamped file reads 0 — no evidence, never an error', () => {
    const stamp = path.join(dir, 'door-activity');
    expect(readDoorActivityAt(stamp)).toBe(0);
    fs.writeFileSync(stamp, new Date().toISOString());
    const at = readDoorActivityAt(stamp);
    expect(at).toBeGreaterThan(0);
    expect(Math.abs(Date.now() - at)).toBeLessThan(5_000);
  });
});

describe('hasLiveAttachEvidence', () => {
  const now = Date.now();
  const fresh = () => ({ clients: 1, at: new Date(now).toISOString(), lastInputAt: now - 1000, lastConnectAt: 0 });

  it('clients on the socket + a fresh stamp + recent human evidence = attached', () => {
    expect(hasLiveAttachEvidence(fresh(), now)).toBe(true);
    // A fresh connect alone is evidence too — a human just walked in.
    expect(hasLiveAttachEvidence({ ...fresh(), lastInputAt: 0, lastConnectAt: now - 1000 }, now)).toBe(true);
  });

  it('absence, zero clients, and damage all read detached — the escalating end', () => {
    expect(hasLiveAttachEvidence(null, now)).toBe(false);
    expect(hasLiveAttachEvidence({ ...fresh(), clients: 0 }, now)).toBe(false);
    expect(hasLiveAttachEvidence({ ...fresh(), at: 'not-a-time' }, now)).toBe(false);
  });

  it('a stale stamp is a dead life, not a report', () => {
    const staleAt = new Date(now - ATTACH_STAMP_FRESH_MS - 1000).toISOString();
    expect(hasLiveAttachEvidence({ ...fresh(), at: staleAt }, now)).toBe(false);
  });

  it("an orphan's socket — clients up, evidence old — is detached (the E-t7 orphan)", () => {
    const orphan = {
      ...fresh(),
      lastInputAt: now - ATTACH_EVIDENCE_MS - 1000,
      lastConnectAt: now - ATTACH_EVIDENCE_MS - 1000,
    };
    expect(hasLiveAttachEvidence(orphan, now)).toBe(false);
    // No evidence fields at all (an old-shape stamp) is the same verdict.
    expect(hasLiveAttachEvidence({ clients: 1, at: new Date(now).toISOString() }, now)).toBe(false);
  });
});

describe('mail notice', () => {
  it('round-trips the waiting sequences and stamps when', () => {
    const noticePath = path.join(dir, 'mail-notice.json');
    const before = Date.now();
    writeMailNotice({ seqs: [2, 6] }, noticePath);
    const notice = readMailNotice(noticePath)!;
    expect(notice.seqs).toEqual([2, 6]);
    expect(Date.parse(notice.at)).toBeGreaterThanOrEqual(before);
  });

  it('absence and damage both read as nothing waiting — the silent end, never a throw', () => {
    const noticePath = path.join(dir, 'mail-notice.json');
    expect(readMailNotice(noticePath)).toBeNull();
    fs.writeFileSync(noticePath, '{"seq');
    expect(readMailNotice(noticePath)).toBeNull();
    // Right shape, wrong contents: a hook must not announce mail on garbage.
    fs.writeFileSync(noticePath, JSON.stringify({ seqs: ['nope'], at: new Date().toISOString() }));
    expect(readMailNotice(noticePath)).toBeNull();
  });

  it('creates its dir 0700 — container-private, like every other stamp here', () => {
    const noticePath = path.join(dir, 'nested', 'mail-notice.json');
    writeMailNotice({ seqs: [] }, noticePath);
    expect(readMailNotice(noticePath)?.seqs).toEqual([]);
    expect(fs.statSync(path.dirname(noticePath)).mode & 0o777).toBe(0o700);
  });
});
