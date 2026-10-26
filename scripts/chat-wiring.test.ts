/**
 * `pnpm run chat` preflight (#2703): setup's recommended path leaves
 * `cli/local` unwired while still advertising the command, and the old
 * behavior was a 120s opaque timeout. The preflight must distinguish
 * wired / unwired / no-messaging-group so the client can fail fast with
 * the wiring hint instead.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initSqliteTestDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { createAgentGroup } from '../src/db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../src/db/messaging-groups.js';
import { checkCliWiring, CLI_CHANNEL, CLI_PLATFORM_ID, WIRE_HINT } from './chat-wiring.js';

beforeEach(async () => {
  const db = await initSqliteTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
});

async function createCliMessagingGroup(): Promise<string> {
  const id = `mg-cli-${Date.now()}`;
  await createMessagingGroup({
    id,
    channel_type: CLI_CHANNEL,
    platform_id: CLI_PLATFORM_ID,
    instance: CLI_CHANNEL,
    name: 'CLI',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: new Date().toISOString(),
  });
  return id;
}

describe('checkCliWiring', () => {
  it('reports no-messaging-group on a fresh database', async () => {
    expect(await checkCliWiring(getDb())).toBe('no-messaging-group');
  });

  it('reports unwired when cli/local exists but no agent is wired — the #2703 state', async () => {
    // Setup's recommended path: the ping-test agent is deleted (cascading the
    // wiring away) but the messaging group is deliberately left behind.
    await createCliMessagingGroup();
    expect(await checkCliWiring(getDb())).toBe('unwired');
  });

  it('reports wired when an agent handles cli/local', async () => {
    const mgId = await createCliMessagingGroup();
    await createAgentGroup({
      id: 'ag-terminal',
      name: "Test's Terminal",
      folder: 'test-terminal',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await createMessagingGroupAgent({
      id: `mga-${Date.now()}`,
      messaging_group_id: mgId,
      agent_group_id: 'ag-terminal',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: new Date().toISOString(),
    });
    expect(await checkCliWiring(getDb())).toBe('wired');
  });

  it('ignores wirings of other messaging groups', async () => {
    await createCliMessagingGroup();
    await createMessagingGroup({
      id: 'mg-telegram',
      channel_type: 'telegram',
      platform_id: 'telegram:42',
      instance: 'telegram',
      name: 'TG',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    await createAgentGroup({
      id: 'ag-tg',
      name: 'TG Agent',
      folder: 'tg-agent',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await createMessagingGroupAgent({
      id: 'mga-tg',
      messaging_group_id: 'mg-telegram',
      agent_group_id: 'ag-tg',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: new Date().toISOString(),
    });
    // The channel agent's wiring must not count as a terminal wiring.
    expect(await checkCliWiring(getDb())).toBe('unwired');
  });

  it('exposes an actionable hint naming the wiring paths', () => {
    expect(WIRE_HINT).toContain('cli/local');
    expect(WIRE_HINT).toContain('init-first-agent');
    expect(WIRE_HINT).toContain('init-cli-agent');
  });
});
