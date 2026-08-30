import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadAuditPseudonymKey, pseudonymizeAuditInputWithKey } from './pseudonym.js';
import type { AuditEventInput } from './types.js';

const KEY = Buffer.from('11'.repeat(32), 'hex');
const OTHER_KEY = Buffer.from('22'.repeat(32), 'hex');
const INPUT: AuditEventInput = {
  eventType: 'ncl_action',
  actor: { type: 'human', id: 'slack:U04T3K9' },
  agentId: null,
  sessionId: null,
  dimensions: {
    transport: 'socket',
    arg_names: [],
    action: 'users.get',
    outcome: 'success',
    resource_refs: ['user:slack:U04T3K9', 'agent_group:group-1'],
  },
};

describe('Host audit keyed pseudonyms', () => {
  it('replaces accountable human identifiers before the canonical event is built', () => {
    const first = pseudonymizeAuditInputWithKey(INPUT, KEY);
    const same = pseudonymizeAuditInputWithKey(INPUT, KEY);
    const otherInstall = pseudonymizeAuditInputWithKey(INPUT, OTHER_KEY);

    expect(first).toEqual(same);
    expect(first).not.toEqual(otherInstall);
    expect(first.actor).toEqual({ type: 'human', id: expect.stringMatching(/^hmac:[0-9a-f]{64}$/) });
    expect(first.dimensions?.resource_refs).toEqual([
      expect.stringMatching(/^user:hmac:[0-9a-f]{64}$/),
      'agent_group:group-1',
    ]);
    expect(JSON.stringify(first)).not.toContain('slack:U04T3K9');
    expect(INPUT.actor?.id).toBe('slack:U04T3K9');
  });

  it('uses one keyed person join across actor and user-resource contexts', () => {
    const output = pseudonymizeAuditInputWithKey(INPUT, KEY);
    const actor = output.actor!.id.slice('hmac:'.length);
    const user = output.dimensions!.resource_refs![0].slice('user:hmac:'.length);
    expect(actor).not.toBe(createHash('sha256').update(INPUT.actor!.id).digest('hex'));
    expect(actor).toBe(user);
  });

  it('leaves agent, system, and non-user structural identifiers unchanged', () => {
    const agentInput: AuditEventInput = {
      ...INPUT,
      actor: { type: 'agent', id: 'agent-support-01' },
      agentId: 'agent-support-01',
      sessionId: 'session-support-01',
      dimensions: { ...INPUT.dimensions, resource_refs: ['task:task-1'] },
    };
    expect(pseudonymizeAuditInputWithKey(agentInput, KEY)).toEqual(agentInput);
  });

  it.each([Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33)])(
    'rejects a key that is not exactly 32 bytes',
    (key) => expect(() => pseudonymizeAuditInputWithKey(INPUT, key)).toThrow(/32 bytes/),
  );

  it('loads only an exact lowercase-hex key from a private regular file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-audit-pseudonym-'));
    const file = path.join(dir, 'key');
    try {
      fs.writeFileSync(file, `${'ab'.repeat(32)}\n`, { mode: 0o600 });
      expect(loadAuditPseudonymKey(file)).toEqual(Buffer.from('ab'.repeat(32), 'hex'));
      fs.chmodSync(file, 0o644);
      expect(() => loadAuditPseudonymKey(file)).toThrow(/mode-0600/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses malformed human identity before pseudonymization can hide it', () => {
    expect(() => pseudonymizeAuditInputWithKey({
      ...INPUT,
      actor: { type: 'human', id: 'bad\nidentity' },
    }, KEY)).toThrow(/actor.id/);
  });
});
