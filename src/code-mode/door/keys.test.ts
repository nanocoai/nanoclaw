/**
 * The approved-keys store: parsing and fingerprints against ssh-keygen
 * vectors, the admission decision (approved / pending / refused past the
 * rate limit), the authorized_keys line each verdict produces, and the
 * operator verbs.
 */
import { describe, expect, it } from 'vitest';

import {
  addApprovedKey,
  admitKey,
  approvePendingKey,
  authorizedKeysLine,
  emptyKeyStore,
  isApproved,
  parsePublicKey,
  PENDING_LIMIT,
  PENDING_RETENTION_MS,
  PENDING_WINDOW_MS,
  revokeKey,
  type KeyStore,
} from './keys.js';

const ED25519 = {
  line: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJcU4MBsyv98bPT4z2Ymq9wLqo52QUi0MKqgu7k5gfGV vector@test',
  fingerprint: 'SHA256:gOakZC+YL189IEEAB60qLI8r+5H3H4lj4iMh5hlYOSo',
};

const RSA = {
  line: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDEBh7ErTcqszy++F+ZX1GtO056ohJedw7yLoqpJ9AfMlDGfKJHp5IoqypEBq6W37EPIXotnem31vs/daqcjlbrViX+Ufsz9WaJ9vQQxHNylYZOG4kndXscVhqFobh4L8KLvMqBi/8Yc16JQHjPWG8aQOVUG7T+FfqIemmdCwclr7I+pF+JaWB0aSr7pfpoh1lT05gb8w272Tg+VcB9v2LG14Qg3Hx975VvdLEAOOLfhNHSXUptZezP1L2jNjSlGWi5c8g1HocooUXUNDXuNy/twX7nwRfa6WW/42cBaziGq9/wnhzifMZBe0dg2h4s5iZQbN+MMr1N5eiNVVd+K26D rsa@test',
  fingerprint: 'SHA256:xb8YsLkluMJDzQ5i1VlDnScktuE3TN/XWX7CtVPUh3c',
};

const T0 = new Date('2026-09-11T12:00:00Z');
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

/** A distinct, well-formed ed25519 key per index (the blob only has to carry its type). */
function syntheticKey(index: number): { publicKey: string; fingerprint: string } {
  const type = Buffer.from('ssh-ed25519');
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, type.length]),
    type,
    Buffer.from([0, 0, 0, 32]),
    Buffer.alloc(32, index),
  ]);
  const parsed = parsePublicKey(`ssh-ed25519 ${blob.toString('base64')}`);
  return { publicKey: parsed.publicKey, fingerprint: parsed.fingerprint };
}

describe('parsePublicKey', () => {
  it('computes the same SHA256 fingerprint as ssh-keygen -lf', () => {
    const ed = parsePublicKey(ED25519.line);
    expect(ed.type).toBe('ssh-ed25519');
    expect(ed.comment).toBe('vector@test');
    expect(ed.publicKey).toBe(ED25519.line.split(' ').slice(0, 2).join(' '));
    expect(ed.fingerprint).toBe(ED25519.fingerprint);
    expect(parsePublicKey(RSA.line).fingerprint).toBe(RSA.fingerprint);
  });

  it('rejects unknown types, bad base64 and blobs of another type', () => {
    expect(() => parsePublicKey('ssh-dss AAAA')).toThrow(/OpenSSH public key line/);
    expect(() => parsePublicKey('ssh-ed25519 not*base64')).toThrow(/base64/);
    const [, rsaBlob] = RSA.line.split(' ');
    expect(() => parsePublicKey(`ssh-ed25519 ${rsaBlob}`)).toThrow(/declared type/);
    expect(() => parsePublicKey('')).toThrow();
  });
});

describe('admitKey', () => {
  it('approves a stored key whose public key matches, refuses a fingerprint collision', () => {
    const key = parsePublicKey(ED25519.line);
    const store = addApprovedKey(emptyKeyStore(), key, 'laptop', T0);
    expect(admitKey(store, key, T0).verdict).toBe('approved');
    expect(admitKey(store, { fingerprint: key.fingerprint, publicKey: 'ssh-ed25519 AAAA' }, T0).verdict).toBe(
      'refused',
    );
  });

  it('records an unknown key as pending once, even when the server asks twice', () => {
    const key = syntheticKey(1);
    const first = admitKey(emptyKeyStore(), key, T0, '203.0.113.5');
    expect(first.verdict).toBe('pending');
    expect(first.changed).toBe(true);
    expect(first.store.pending).toEqual([
      {
        fingerprint: key.fingerprint,
        publicKey: key.publicKey,
        firstSeenAt: T0.toISOString(),
        lastSeenAt: T0.toISOString(),
        source: '203.0.113.5',
      },
    ]);
    const second = admitKey(first.store, key, at(500));
    expect(second.verdict).toBe('pending');
    expect(second.store.pending).toHaveLength(1);
    expect(second.store.pending[0].lastSeenAt).toBe(at(500).toISOString());
    expect(second.store.pending[0].firstSeenAt).toBe(T0.toISOString());
  });

  it(`refuses the ${PENDING_LIMIT + 1}th unknown key inside the window and admits again once it passes`, () => {
    let store: KeyStore = emptyKeyStore();
    for (let i = 1; i <= PENDING_LIMIT; i++) {
      const result = admitKey(store, syntheticKey(i), at(i * 1000));
      expect(result.verdict).toBe('pending');
      store = result.store;
    }
    const refused = admitKey(store, syntheticKey(PENDING_LIMIT + 1), at(PENDING_LIMIT * 1000 + 1));
    expect(refused.verdict).toBe('refused');
    expect(refused.store.pending).toHaveLength(PENDING_LIMIT);
    // A key that is already pending is never refused by the limit.
    expect(admitKey(store, syntheticKey(1), at(PENDING_LIMIT * 1000 + 2)).verdict).toBe('pending');
    // Once the window has passed, new keys are admitted again.
    const later = admitKey(store, syntheticKey(PENDING_LIMIT + 1), at(PENDING_WINDOW_MS + 2000));
    expect(later.verdict).toBe('pending');
    expect(later.store.pending).toHaveLength(PENDING_LIMIT + 1);
  });

  it('forgets pending keys nobody approved after the retention period', () => {
    const stale = admitKey(emptyKeyStore(), syntheticKey(1), T0).store;
    const result = admitKey(stale, syntheticKey(2), at(PENDING_RETENTION_MS + 1));
    expect(result.store.pending.map((k) => k.fingerprint)).toEqual([syntheticKey(2).fingerprint]);
  });
});

describe('authorizedKeysLine', () => {
  const key = parsePublicKey(ED25519.line);

  it('pins an approved key to the landing program with restrict and pty', () => {
    const line = authorizedKeysLine('approved', key, '/srv/host/data/door', '/opt/node/bin/node');
    expect(line).toMatch(
      /^restrict,pty,command="'\/opt\/node\/bin\/node' .*landing\.[jt]s' '\/srv\/host\/data\/door' 'SHA256:/,
    );
    expect(line?.endsWith(` ${key.publicKey}`)).toBe(true);
    expect(line).not.toContain('waiting-room');
  });

  it('pins an unknown key to the waiting room, and prints nothing for a refused key', () => {
    const line = authorizedKeysLine('pending', key, '/srv/host/data/door');
    expect(line).toContain('waiting-room');
    expect(line).not.toContain('landing');
    expect(authorizedKeysLine('refused', key, '/srv/host/data/door')).toBeUndefined();
  });

  it('escapes the option layer so a quote in the door path cannot break out', () => {
    const line = authorizedKeysLine('approved', key, `/srv/it's "here"`);
    // Shell single-quote for the apostrophe (`'\''`), then the option layer
    // doubles the backslash and escapes the double quotes.
    expect(line).toContain(`'/srv/it'\\\\''s \\"here\\"'`);
  });
});

describe('operator verbs', () => {
  const key = parsePublicKey(ED25519.line);

  it('approves a pending key by fingerprint, labels it by its source, and clears it from pending', () => {
    const pending = admitKey(emptyKeyStore(), key, T0, '203.0.113.5').store;
    const store = approvePendingKey(pending, key.fingerprint, undefined, at(1000));
    expect(store.pending).toEqual([]);
    expect(store.approved).toEqual([
      {
        fingerprint: key.fingerprint,
        publicKey: key.publicKey,
        label: '203.0.113.5',
        approvedAt: at(1000).toISOString(),
      },
    ]);
    expect(isApproved(store, key.fingerprint)).toBe(true);
    expect(() => approvePendingKey(emptyKeyStore(), 'SHA256:nope')).toThrow(/no pending key/);
  });

  it('adds a key directly with the comment as the default label, and revokes by fingerprint', () => {
    const store = addApprovedKey(emptyKeyStore(), key, '', T0);
    expect(store.approved[0].label).toBe('vector@test');
    const revoked = revokeKey(store, key.fingerprint);
    expect(revoked.approved).toEqual([]);
    expect(() => revokeKey(revoked, key.fingerprint)).toThrow(/no key/);
  });
});
