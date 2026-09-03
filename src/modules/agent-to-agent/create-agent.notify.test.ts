/**
 * Tests for createAgent's CreateAgentOptions.suppressCreatedNotify (D5).
 *
 * The upstream success notify ("created — you can now message it") fires
 * before any wrapper post-processing (e.g. slack-agent-flow provisioning), so
 * wrappers that own the completion signal pass suppressCreatedNotify to keep
 * the requester from hearing "done" early. Error notifies (collision) must
 * still fire — they are the only signal on those paths.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';

// vi.hoisted: the module import below runs before this file's const
// initializers, and the mock factories close over this state.
const { mockNotifyWrite, destinations } = vi.hoisted(() => ({
  mockNotifyWrite: vi.fn(),
  destinations: new Map<string, { target_type: string; target_id: string }>(),
}));

vi.mock('../approvals/index.js', () => ({
  requestApproval: vi.fn().mockResolvedValue(undefined),
  notifyAgent: vi.fn(),
  registerApprovalHandler: vi.fn(),
}));
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: () => ({ cli_scope: 'global' }),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => ({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: '' }),
  getAgentGroupByFolder: () => undefined,
  createAgentGroup: vi.fn(),
}));
vi.mock('../../group-init.js', () => ({ initGroupFilesystem: vi.fn() }));
vi.mock('./write-destinations.js', () => ({ writeDestinations: vi.fn() }));
vi.mock('./db/agent-destinations.js', () => ({
  getDestinationByName: (group: string, name: string) => destinations.get(`${group}/${name}`),
  createDestination: vi.fn(),
  normalizeName: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
}));
// notifyAgent writes to the session inbound.db + wakes the container; stub both.
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...a: unknown[]) => mockNotifyWrite(...a),
}));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../db/sessions.js', () => ({
  getSession: (id: string) => ({ id, agent_group_id: 'ag-1' }),
}));

import { createAgent } from './create-agent.js';

const SESSION = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;

function notifyTexts(): string[] {
  return mockNotifyWrite.mock.calls.map((c) => JSON.parse((c[2] as { content: string }).content).text as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  destinations.clear();
});

describe('createAgent — suppressCreatedNotify option', () => {
  it('default: the success notify fires', async () => {
    await createAgent({ name: 'Scout' }, SESSION);

    expect(notifyTexts().some((t) => t.includes('Agent "scout" created'))).toBe(true);
  });

  it('suppressCreatedNotify: creation runs but the success notify is silenced', async () => {
    await createAgent({ name: 'Scout' }, SESSION, { suppressCreatedNotify: true });

    expect(notifyTexts()).toHaveLength(0);
  });

  it('suppressCreatedNotify does NOT silence the collision error notify', async () => {
    destinations.set('ag-1/scout', { target_type: 'agent', target_id: 'ag-existing' });

    await createAgent({ name: 'Scout' }, SESSION, { suppressCreatedNotify: true });

    expect(notifyTexts().some((t) => t.includes('already have a destination named "scout"'))).toBe(true);
  });
});
