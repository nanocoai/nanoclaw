import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/nanoclaw-test-remote-tokens-${process.pid}` }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

import { isSafeMailboxId, isSafeOutboxFilename, parseSessionHeader } from './ids.js';
import { issueMailboxToken, revokeMailboxToken, verifyMailboxToken } from './tokens.js';

const KEY = { agentGroupId: 'ag-1', sessionId: 'sess-1' };
const HEADER = 'ag-1/sess-1';

beforeEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));
afterEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

describe('mailbox tokens', () => {
  it('issues a 32-byte base64url token that verifies for exactly its session', () => {
    const token = issueMailboxToken(KEY);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyMailboxToken(`Bearer ${token}`, HEADER)).toEqual(KEY);
  });

  it('stores only the sha256 hash, with 0700 dirs and a 0600 file', () => {
    const token = issueMailboxToken(KEY);
    const file = path.join(TEST_DIR, 'mailbox-tokens', 'ag-1', 'sess-1');
    expect(fs.readFileSync(file, 'utf8')).toBe(crypto.createHash('sha256').update(token).digest('hex') + '\n');
    expect(fs.readFileSync(file, 'utf8')).not.toContain(token);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(TEST_DIR, 'mailbox-tokens')).mode & 0o777).toBe(0o700);
  });

  it('rejects wrong, missing, and malformed credentials', () => {
    const token = issueMailboxToken(KEY);
    const other = crypto.randomBytes(32).toString('base64url');
    expect(verifyMailboxToken(`Bearer ${other}`, HEADER)).toBeNull();
    expect(verifyMailboxToken(undefined, HEADER)).toBeNull();
    expect(verifyMailboxToken('', HEADER)).toBeNull();
    expect(verifyMailboxToken(token, HEADER)).toBeNull(); // no Bearer scheme
    expect(verifyMailboxToken(`bearer ${token}`, HEADER)).toBeNull();
    expect(verifyMailboxToken(`Bearer ${token} extra`, HEADER)).toBeNull();
    expect(verifyMailboxToken(`Bearer ${token}`, undefined)).toBeNull();
    expect(verifyMailboxToken(`Bearer ${token}`, 'ag-1')).toBeNull();
    expect(verifyMailboxToken(`Bearer ${token}`, 'ag-1/sess-1/extra')).toBeNull();
  });

  it('a token for session A does not open session B, even one that has its own token', () => {
    const a = issueMailboxToken(KEY);
    issueMailboxToken({ agentGroupId: 'ag-1', sessionId: 'sess-2' });
    expect(verifyMailboxToken(`Bearer ${a}`, 'ag-1/sess-2')).toBeNull();
    expect(verifyMailboxToken(`Bearer ${a}`, 'ag-2/sess-1')).toBeNull();
  });

  it('revocation takes effect immediately and is idempotent', () => {
    const token = issueMailboxToken(KEY);
    revokeMailboxToken(KEY);
    revokeMailboxToken(KEY);
    expect(verifyMailboxToken(`Bearer ${token}`, HEADER)).toBeNull();
  });

  it('re-issuing keeps a reused live runtime working: the newest few tokens stay valid', () => {
    // prepare() is idempotent on key, so a spawn can reuse a runtime started
    // with an earlier token (e.g. left unadopted after a hard host kill).
    const tokens = Array.from({ length: 5 }, () => issueMailboxToken(KEY));
    expect(verifyMailboxToken(`Bearer ${tokens[0]}`, HEADER)).toBeNull();
    for (const token of tokens.slice(1)) expect(verifyMailboxToken(`Bearer ${token}`, HEADER)).toEqual(KEY);
    revokeMailboxToken(KEY);
    for (const token of tokens) expect(verifyMailboxToken(`Bearer ${token}`, HEADER)).toBeNull();
  });

  it('refuses to issue for malformed ids and never writes outside the token root', () => {
    for (const bad of [
      { agentGroupId: '../x', sessionId: 's' },
      { agentGroupId: 'a', sessionId: '../../etc' },
      { agentGroupId: 'a/b', sessionId: 's' },
      { agentGroupId: '', sessionId: 's' },
      { agentGroupId: 'a', sessionId: 'x'.repeat(129) },
      { agentGroupId: 'a\0', sessionId: 's' },
    ]) {
      expect(() => issueMailboxToken(bad)).toThrow();
    }
    expect(fs.existsSync(path.join(TEST_DIR, 'mailbox-tokens'))).toBe(false);
  });

  it('a hash file with garbage content never verifies', () => {
    issueMailboxToken(KEY);
    const file = path.join(TEST_DIR, 'mailbox-tokens', 'ag-1', 'sess-1');
    fs.writeFileSync(file, 'not-a-hash');
    expect(verifyMailboxToken('Bearer AAAA', HEADER)).toBeNull();
  });
});

describe('id rules', () => {
  it('session ids and header parsing are strict', () => {
    expect(isSafeMailboxId('abc_DEF-123')).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', 'a b', 'a\0', 'x'.repeat(129), 5, null]) {
      expect(isSafeMailboxId(bad)).toBe(false);
    }
    expect(parseSessionHeader('a/b')).toEqual({ agentGroupId: 'a', sessionId: 'b' });
    expect(parseSessionHeader('a/../b')).toBeNull();
    expect(parseSessionHeader('../b')).toBeNull();
    expect(parseSessionHeader(['a/b'])).toBeNull();
  });

  it('outbox filenames are plain basenames without a leading dot', () => {
    expect(isSafeOutboxFilename('report.pdf')).toBe(true);
    for (const bad of ['', '.', '..', '.hidden', 'a/b', 'a\\b', 'a\0', 'x'.repeat(256)]) {
      expect(isSafeOutboxFilename(bad)).toBe(false);
    }
  });
});
