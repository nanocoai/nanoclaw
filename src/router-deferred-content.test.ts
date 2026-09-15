/**
 * Deferred delivery content (adapter.ts: InboundMessage.resolveContent).
 *
 * The router decides on the cheap routing view and pulls the expensive one
 * only when an agent is actually going to persist the message. For WhatsApp
 * that expensive step is downloading attachment bytes from the CDN — most
 * inbound traffic is in chats with no wiring at all, and every one of those
 * downloads was wasted before this seam existed.
 */
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { findSessionForAgent } from './db/sessions.js';
import { withExistingMailboxSession } from './session-manager.js';
import type { InboundEvent } from './channels/adapter.js';
import type { IgnoredMessagePolicy } from './types.js';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-deferred' };
});

const TEST_DIR = '/tmp/nanoclaw-test-deferred';

function now() {
  return new Date().toISOString();
}

/** Routing view: text + attachment metadata, no bytes. */
const ROUTING = JSON.stringify({
  sender: 'User',
  text: '@Jarbas read this',
  attachments: [{ type: 'document', name: 'report.pdf' }],
});

/** Delivery view: the same, with the bytes filled in. */
const DELIVERED = JSON.stringify({
  sender: 'User',
  text: '@Jarbas read this',
  attachments: [{ type: 'document', name: 'report.pdf', data: 'YmFzZTY0' }],
});

function makeEvent(overrides: {
  platformId?: string;
  text?: string;
  resolveContent?: () => Promise<string>;
}): InboundEvent {
  const content = overrides.text ? JSON.stringify({ sender: 'User', text: overrides.text }) : ROUTING;
  return {
    channelType: 'discord',
    platformId: overrides.platformId ?? 'chan-123',
    threadId: null,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 10)}`,
      kind: 'chat',
      content,
      timestamp: now(),
      resolveContent: overrides.resolveContent,
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function storedContent(agentGroupId: string): Promise<any[]> {
  const session = await findSessionForAgent(agentGroupId, 'mg-1', null);
  if (!session) return [];
  // Storage layout is mailbox-private now — read the inbox through the
  // mailbox seam rather than opening inbound.db directly.
  const rows = await withExistingMailboxSession(agentGroupId, session.id, (mailbox) => mailbox.getInboundHistory(100));
  return (rows ?? []).map((r) => JSON.parse(r.content));
}

/**
 * writeSessionMessage stages inline `data` into the session inbox and
 * rewrites it to a container-visible `localPath` — so a staged localPath (and
 * no leftover base64) is the proof that the bytes actually arrived.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function expectBytesStaged(att: any) {
  expect(att.localPath).toBeTruthy();
  expect(att.data).toBeUndefined();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());

  await createAgentGroup({ id: 'ag-1', name: 'Jarbas', folder: 'jarbas', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: 'chan-123',
    name: 'General',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

/** Wire an agent group to mg-1 with the given engage pattern. */
async function wire(id: string, agentGroupId: string, pattern: string, ignored: IgnoredMessagePolicy = 'drop') {
  await createMessagingGroupAgent({
    id,
    messaging_group_id: 'mg-1',
    agent_group_id: agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: pattern,
    sender_scope: 'all',
    ignored_message_policy: ignored,
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

describe('deferred delivery content', () => {
  it('resolves and persists the delivery view when an agent engages', async () => {
    const { routeInbound } = await import('./router.js');
    await wire('mga-1', 'ag-1', '.');

    const resolveContent = vi.fn().mockResolvedValue(DELIVERED);
    await routeInbound(makeEvent({ resolveContent }));

    expect(resolveContent).toHaveBeenCalledTimes(1);
    const stored = await storedContent('ag-1');
    expect(stored).toHaveLength(1);
    expectBytesStaged(stored[0].attachments[0]);
  });

  it('never resolves when no agent engages', async () => {
    const { routeInbound } = await import('./router.js');
    await wire('mga-1', 'ag-1', '@[Jj]arbas');

    const resolveContent = vi.fn().mockResolvedValue(DELIVERED);
    await routeInbound(makeEvent({ text: 'just chatting', resolveContent }));

    expect(resolveContent).not.toHaveBeenCalled();
    expect(await storedContent('ag-1')).toHaveLength(0);
  });

  it('never resolves for a chat with no wiring at all', async () => {
    const { routeInbound } = await import('./router.js');
    await wire('mga-1', 'ag-1', '.');

    const resolveContent = vi.fn().mockResolvedValue(DELIVERED);
    await routeInbound(makeEvent({ platformId: 'chan-unwired', resolveContent }));

    expect(resolveContent).not.toHaveBeenCalled();
  });

  it('resolves once for a fan-out to several engaged agents', async () => {
    const { routeInbound } = await import('./router.js');
    await createAgentGroup({ id: 'ag-2', name: 'Second', folder: 'second', agent_provider: null, created_at: now() });
    await wire('mga-1', 'ag-1', '.');
    await wire('mga-2', 'ag-2', '.');

    const resolveContent = vi.fn().mockResolvedValue(DELIVERED);
    await routeInbound(makeEvent({ resolveContent }));

    // One download, two sessions fed from it.
    expect(resolveContent).toHaveBeenCalledTimes(1);
    expectBytesStaged((await storedContent('ag-1'))[0].attachments[0]);
    expectBytesStaged((await storedContent('ag-2'))[0].attachments[0]);
  });

  it('resolves for an accumulating agent — the message is still persisted', async () => {
    const { routeInbound } = await import('./router.js');
    await wire('mga-1', 'ag-1', '@[Jj]arbas', 'accumulate');

    const resolveContent = vi.fn().mockResolvedValue(DELIVERED);
    await routeInbound(makeEvent({ text: 'just chatting', resolveContent }));

    expect(resolveContent).toHaveBeenCalledTimes(1);
    expect(await storedContent('ag-1')).toHaveLength(1);
  });

  it('falls back to the routing view when resolution fails', async () => {
    const { routeInbound } = await import('./router.js');
    await wire('mga-1', 'ag-1', '.');

    const resolveContent = vi.fn().mockRejectedValue(new Error('CDN fetch failed'));
    await routeInbound(makeEvent({ resolveContent }));

    // The bytes are lost; the message and its metadata are not.
    const parsed = (await storedContent('ag-1'))[0];
    expect(parsed.text).toBe('@Jarbas read this');
    expect(parsed.attachments[0].name).toBe('report.pdf');
    expect(parsed.attachments[0].localPath).toBeUndefined();
  });

  it('delivers content as-is for adapters that set no resolver', async () => {
    const { routeInbound } = await import('./router.js');
    await wire('mga-1', 'ag-1', '.');

    await routeInbound(makeEvent({}));

    expect((await storedContent('ag-1'))[0].attachments[0].name).toBe('report.pdf');
  });
});
