import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent, updateMessagingGroup } from '../db/messaging-groups.js';
import { addMember, removeMember } from '../modules/permissions/db/agent-group-members.js';
import { createUser, updateDisplayName } from '../modules/permissions/db/users.js';
import { grantRole, isOwner } from '../modules/permissions/db/user-roles.js';
import { resolveVoiceLine, sessionConfig } from './gpt-live-prompt.js';

const stamp = () => new Date().toISOString();
const ETHAN = 'voice:ethan-test';
const LAURA = 'voice:laura-test';

async function line(id: string, name: string) {
  await createUser({ id, kind: 'voice', display_name: name, created_at: stamp() });
  await createMessagingGroup({
    id: `mg-${id}`,
    channel_type: 'voice',
    platform_id: id,
    instance: 'voice',
    name: 'Personal call',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: stamp(),
  });
  await createMessagingGroupAgent({
    id: `wire-${id}`,
    messaging_group_id: `mg-${id}`,
    agent_group_id: 'voice-agent',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'known',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: stamp(),
  });
}
const allow = (id: string) =>
  addMember({ user_id: id, agent_group_id: 'voice-agent', added_by: null, added_at: stamp() });

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: 'voice-agent',
    name: 'Casa',
    folder: 'voice-access-fixture',
    agent_provider: null,
    created_at: stamp(),
  });
  await line(ETHAN, 'Ethan');
});
afterEach(async () => {
  await closeDb();
});

describe('personal voice line access (real central DB)', () => {
  it('requires explicit membership and never infers ownership from a matching name', async () => {
    await createUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Ethan', created_at: stamp() });
    await grantRole({
      user_id: 'telegram:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: stamp(),
    });
    expect(await resolveVoiceLine(ETHAN)).toBeNull();
    await allow(ETHAN);
    const access = await resolveVoiceLine(ETHAN);
    expect(access).toMatchObject({
      caller: { id: ETHAN, name: 'Ethan' },
      agent: { name: 'Casa' },
      agentGroupId: 'voice-agent',
    });
    expect(await isOwner(ETHAN)).toBe(false);
    expect(sessionConfig(access!.agent, 'marin', access!.caller).instructions).toContain(
      JSON.stringify(access!.caller),
    );
  });

  it('keeps two people distinct when they call the same agent', async () => {
    await line(LAURA, 'Laura');
    await allow(ETHAN);
    await allow(LAURA);
    const first = await resolveVoiceLine(ETHAN);
    const second = await resolveVoiceLine(LAURA);
    expect(first?.agentGroupId).toBe(second?.agentGroupId);
    expect(first?.caller).toEqual({ id: ETHAN, name: 'Ethan' });
    expect(second?.caller).toEqual({ id: LAURA, name: 'Laura' });
  });

  it('denies revoked, anonymous, and public lines', async () => {
    await allow(ETHAN);
    expect(await resolveVoiceLine(ETHAN)).not.toBeNull();
    await removeMember(ETHAN, 'voice-agent');
    expect(await resolveVoiceLine(ETHAN)).toBeNull();
    await allow(ETHAN);
    await updateDisplayName(ETHAN, ' ');
    expect(await resolveVoiceLine(ETHAN)).toBeNull();
    await updateDisplayName(ETHAN, 'Ethan');
    await updateMessagingGroup(`mg-${ETHAN}`, { unknown_sender_policy: 'public' });
    expect(await resolveVoiceLine(ETHAN)).toBeNull();
    expect(await resolveVoiceLine('voice:unknown')).toBeNull();
  });

  it('refuses ambiguous wiring to multiple agents', async () => {
    await allow(ETHAN);
    await createAgentGroup({
      id: 'other-agent',
      name: 'Other',
      folder: 'voice-access-other',
      agent_provider: null,
      created_at: stamp(),
    });
    await createMessagingGroupAgent({
      id: 'second-wire',
      messaging_group_id: `mg-${ETHAN}`,
      agent_group_id: 'other-agent',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'known',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 1,
      created_at: stamp(),
    });
    expect(await resolveVoiceLine(ETHAN)).toBeNull();
  });
});
