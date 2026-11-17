/**
 * wouldAdmitSender: the chat's admission rule (the access gate plus the
 * wiring's sender_scope), answered without the gate's side effects.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { wouldAdmitSender } from './access.js';
import { addMember } from './db/agent-group-members.js';
import { getUser, upsertUser } from './db/users.js';

const NOW = new Date().toISOString();
const strict = { unknown_sender_policy: 'strict' as const };
const open = { unknown_sender_policy: 'public' as const };
const anyone = { agent_group_id: 'ag-1', sender_scope: 'all' as const };
const knownOnly = { agent_group_id: 'ag-1', sender_scope: 'known' as const };

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup({ id: 'ag-1', name: 'Pip', folder: 'pip', agent_provider: null, created_at: NOW });
  await upsertUser({ id: 'chat:member', kind: 'chat', display_name: 'Dana', created_at: NOW });
  await addMember({ user_id: 'chat:member', agent_group_id: 'ag-1', added_by: null, added_at: NOW });
});

afterEach(async () => {
  await closeDb();
});

describe('wouldAdmitSender', () => {
  it('admits a member, and anyone on a public chat whose wiring takes all senders', async () => {
    expect(await wouldAdmitSender('chat:member', strict, anyone)).toBe(true);
    expect(await wouldAdmitSender('chat:stranger', open, anyone)).toBe(true);
  });

  it('refuses a stranger on a strict chat, or on a public chat whose wiring takes known senders only', async () => {
    expect(await wouldAdmitSender('chat:stranger', strict, anyone)).toBe(false);
    expect(await wouldAdmitSender('chat:stranger', open, knownOnly)).toBe(false);
    expect(await wouldAdmitSender('chat:member', open, knownOnly)).toBe(true);
  });

  it('records nothing about the sender it refuses', async () => {
    await wouldAdmitSender('chat:stranger', strict, anyone);

    expect(await getUser('chat:stranger')).toBeUndefined();
    expect(await getDb().all('SELECT * FROM unregistered_senders')).toHaveLength(0);
    expect(await getDb().all('SELECT * FROM pending_sender_approvals')).toHaveLength(0);
  });
});
